// SPDX-License-Identifier: AGPL-3.0-only
use sqlx::{migrate::Migrator, postgres::PgPoolOptions, Row};
use std::borrow::Cow;
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
    suncharts_engine::test_db::create_schema(&base, &schema).await;
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

#[tokio::test]
async fn deployed_schema_61_upgrades_without_checksum_drift() {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("migration_upgrade_{}", Uuid::new_v4().simple());
    let base = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
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

    let through_61 = Migrator {
        migrations: Cow::Owned(
            suncharts_engine::MIGRATOR
                .iter()
                .filter(|migration| migration.version <= 61)
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    through_61.run(&pool).await.unwrap();

    let applied_checksum: Vec<u8> =
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version=61 AND success")
            .fetch_one(&pool)
            .await
            .unwrap();
    let applied_checksum = applied_checksum
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(
        applied_checksum,
        "f264ed1ce1487a9a56f69c0b03fce30d8008e18177058c78fea8e112ebbac2628f42568bfc69dfb7b1845dd3fb40eb81"
    );

    suncharts_engine::MIGRATOR.run(&pool).await.unwrap();
    let version: i64 =
        sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations WHERE success")
            .fetch_one(&pool)
            .await
            .unwrap();
    let expected_version = suncharts_engine::MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap();
    assert_eq!(version, expected_version);

    sqlx::query(
        "INSERT INTO partner_support_sessions
         (token_hash,tenant_id,grant_id,partner_id,customer_id,order_id,issuer,audience,expires_at,actor_subject,delegated_role)
         VALUES ('workflow-manager-upgrade',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
                 'https://connect.suncharts.app','https://clinic.suncharts.app',clock_timestamp()+interval '15 minutes',
                 'upgrade-test','workflow_manager')",
    )
    .execute(&pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn system_managed_mrn_upgrade_preserves_existing_patient_records() {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("migration_mrn_{}", Uuid::new_v4().simple());
    let base = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    suncharts_engine::test_db::create_schema(&base, &schema).await;
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
    let through_90 = Migrator {
        migrations: Cow::Owned(
            suncharts_engine::MIGRATOR
                .iter()
                .filter(|migration| migration.version <= 90)
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    through_90.run(&pool).await.unwrap();
    let tenant = Uuid::new_v4();
    let patient = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date)
         VALUES($1,$2,'2','Avery','Synthetic','1990-01-02'),
               ($1,$3,'Legacy-Imported-0042','Morgan','Synthetic','1980-03-04'),
               ($4,$5,'2','Jordan','Synthetic','1970-05-06')",
    )
    .bind(tenant)
    .bind(patient)
    .bind(Uuid::new_v4())
    .bind(Uuid::new_v4())
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();
    let snapshot_query =
        "SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY tenant_id,id),'[]'::jsonb) FROM patients p";
    let before: serde_json::Value = sqlx::query_scalar(snapshot_query)
        .fetch_one(&pool)
        .await
        .unwrap();

    suncharts_engine::MIGRATOR.run(&pool).await.unwrap();
    let after: serde_json::Value = sqlx::query_scalar(snapshot_query)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        before, after,
        "upgrade must preserve every existing patient field"
    );

    sqlx::query("UPDATE patients SET family_name='Corrected',identity_version=identity_version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(tenant).bind(patient).execute(&pool).await.unwrap();
    let mrn: String = sqlx::query_scalar("SELECT mrn FROM patients WHERE tenant_id=$1 AND id=$2")
        .bind(tenant)
        .bind(patient)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        mrn, "2",
        "identity corrections preserve historical manual MRNs"
    );
    assert!(sqlx::query("UPDATE patients SET mrn='REPLACED',identity_version=identity_version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(tenant).bind(patient).execute(&pool).await.is_err());

    // Reviewed source imports still insert the identifier carried by their source record.
    let imported: String = sqlx::query_scalar(
        "INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date)
         VALUES($1,$2,'Source-After-Upgrade','Quinn','Synthetic','1995-07-08') RETURNING mrn",
    )
    .bind(tenant)
    .bind(Uuid::new_v4())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(imported, "Source-After-Upgrade");
}
