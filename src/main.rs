// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 P Industries
use sqlx::postgres::PgPoolOptions;
use std::{env, sync::Arc};
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
    let delivery_config = suncharts_engine::delivery::Config::from_env()
        .map_err(|_| "invalid clearinghouse configuration")?;
    if !delivery_config.routes.is_empty() {
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
    let app = suncharts_engine::app(State {
        backend: Arc::new(PostgresBackend(db)),
        browser: Some(browser),
        secret,
        allow_legacy_gateway,
        issuer: env::var("ENGINE_TOKEN_ISSUER").unwrap_or_else(|_| "suncharts".into()),
        audience: env::var("ENGINE_TOKEN_AUDIENCE").unwrap_or_else(|_| "suncharts-engine".into()),
    });
    let listener = tokio::net::TcpListener::bind(
        env::var("ENGINE_BIND").unwrap_or_else(|_| "127.0.0.1:8090".into()),
    )
    .await?;
    eprintln!(
        "SunCharts Engine listening on {}; source available at /source",
        listener.local_addr()?
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
