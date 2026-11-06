// SPDX-License-Identifier: AGPL-3.0-only
use sqlx::{postgres::PgPoolOptions, Row};
use uuid::Uuid;

#[tokio::test]
async fn all_migrations_apply_to_a_fresh_database_schema() {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("migration_smoke_{}", Uuid::new_v4().simple());
    let base = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&base)
        .await
        .unwrap();
    base.close().await;

    let pool = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(move |connection, _| {
            let query = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(&query).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();

    suncharts_engine::MIGRATOR.run(&pool).await.unwrap();
    let applied = sqlx::query(
        "SELECT count(*) AS count, max(version) AS version FROM _sqlx_migrations WHERE success",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let expected_count = suncharts_engine::MIGRATOR.iter().count() as i64;
    let expected_version = suncharts_engine::MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap();
    assert_eq!(applied.get::<i64, _>("count"), expected_count);
    assert_eq!(applied.get::<i64, _>("version"), expected_version);
}
