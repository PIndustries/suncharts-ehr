// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
use sqlx::postgres::PgPoolOptions;
use std::{env, future::IntoFuture, sync::Arc, time::Duration};
use suncharts_engine::{postgres::PostgresBackend, State};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let allow_legacy_gateway = env::var("ENGINE_ALLOW_LEGACY_GATEWAY").as_deref() == Ok("true");
    let secret = env::var("ENGINE_JWT_SECRET").unwrap_or_default();
    if allow_legacy_gateway && secret.len() < 32 {
        return Err("ENGINE_JWT_SECRET must contain at least 32 bytes".into());
    }
    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&env::var("ENGINE_DATABASE_URL").map_err(|_| "ENGINE_DATABASE_URL is required")?)
        .await
        .map_err(|_| "engine database connection failed")?;
    suncharts_engine::MIGRATOR
        .run(&db)
        .await
        .map_err(|_| "engine database migration failed")?;
    suncharts_engine::browser::bootstrap(&db).await?;
    tokio::spawn(suncharts_engine::reminders::run(db.clone()));
    tokio::spawn(suncharts_engine::connect_updates::run(db.clone()));
    tokio::spawn(suncharts_engine::referral_delivery::run(db.clone()));
    let delivery_config = suncharts_engine::delivery::Config::from_env()
        .map_err(|_| "invalid clearinghouse configuration")?;
    {
        tokio::spawn(suncharts_engine::retrieval::run(
            db.clone(),
            delivery_config.clone(),
        ));
        tokio::spawn(suncharts_engine::delivery::run(db.clone(), delivery_config));
    }
    let browser = suncharts_engine::browser::BrowserAuth::new(
        db.clone(),
        env::var("ENGINE_PUBLIC_URL").unwrap_or_else(|_| "http://127.0.0.1:8090".into()),
    )?;
    let state = State {
        backend: Arc::new(PostgresBackend(db)),
        browser: Some(browser),
        secret,
        allow_legacy_gateway,
        issuer: env::var("ENGINE_TOKEN_ISSUER").unwrap_or_else(|_| "suncharts".into()),
        audience: env::var("ENGINE_TOKEN_AUDIENCE").unwrap_or_else(|_| "suncharts-engine".into()),
    };
    let (connect_stop, receiver) = tokio::sync::watch::channel(false);
    let mut connect_worker = tokio::spawn(suncharts_engine::connect_transport::run_with_shutdown(
        state.clone(),
        receiver,
    ));
    let app = suncharts_engine::app(state);
    let listener = tokio::net::TcpListener::bind(
        env::var("ENGINE_BIND").unwrap_or_else(|_| "127.0.0.1:8090".into()),
    )
    .await?;
    eprintln!(
        "SunCharts Engine listening on {}; source available at /source",
        listener.local_addr()?
    );
    let (http_stop, stopped) = tokio::sync::oneshot::channel();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        })
        .into_future();
    tokio::pin!(server);
    let result = tokio::select! {
        result = &mut server => result,
        signal = shutdown_signal() => {
            signal?;
            let _ = connect_stop.send(true);
            let _ = http_stop.send(());
            // Status and clinical SSE streams can remain open indefinitely.
            // Bound the HTTP drain instead of waiting forever for those clients.
            match tokio::time::timeout(Duration::from_secs(10), &mut server).await {
                Ok(result) => result,
                Err(_) => Ok(()),
            }
        }
    };
    let _ = connect_stop.send(true);
    if tokio::time::timeout(Duration::from_secs(3), &mut connect_worker)
        .await
        .is_err()
    {
        connect_worker.abort();
    }
    result?;
    Ok(())
}

async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await
}
