// SPDX-License-Identifier: AGPL-3.0-only
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{migrate::Migrator, postgres::PgPoolOptions, PgPool};
use std::{borrow::Cow, collections::BTreeMap};
use uuid::Uuid;

fn through_revision(version: i64) -> Migrator {
    Migrator {
        migrations: Cow::Owned(
            suncharts_engine::MIGRATOR
                .iter()
                .filter(|migration| migration.version <= version)
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    }
}

async fn snapshot_tables(pool: &PgPool, tables: &[String]) -> BTreeMap<String, (Value, String)> {
    let mut snapshots = BTreeMap::new();
    for table in tables {
        // Names come from pg_tables for the isolated schema, not request input.
        let quoted = table.replace('"', "\"\"");
        let rows: Value = sqlx::query_scalar(&format!(
            "SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)
             FROM \"{quoted}\" r"
        ))
        .fetch_one(pool)
        .await
        .unwrap();
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&rows).unwrap()));
        snapshots.insert(table.clone(), (rows, digest));
    }
    snapshots
}

#[tokio::test]
async fn schema_88_workflow_rows_survive_invoice_copay_and_mrn_upgrade_exactly() {
    let url = std::env::var("TEST_DATABASE_URL").expect("disposable TEST_DATABASE_URL required");
    let schema = format!("workflow_upgrade_{}", Uuid::new_v4().simple());
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
    through_revision(88).run(&pool).await.unwrap();
    let version: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(version, 88, "fixture must start before new billing tables");

    // Seed through SQL so the fixture represents the old schema, independently of
    // current handlers. Every identifier, patient detail, document and amount is synthetic.
    sqlx::raw_sql(
        r#"
DO $$
DECLARE
 tenant uuid := '10000000-0000-0000-0000-000000000001';
 second_tenant uuid := '10000000-0000-0000-0000-000000000002';
 patient uuid := '20000000-0000-0000-0000-000000000001';
 second_patient uuid := '20000000-0000-0000-0000-000000000002';
 actor uuid := '30000000-0000-0000-0000-000000000001';
 appointment uuid := '40000000-0000-0000-0000-000000000001';
 visit uuid := '50000000-0000-0000-0000-000000000001';
 payer uuid := '60000000-0000-0000-0000-000000000001';
 coverage uuid := '60000000-0000-0000-0000-000000000002';
 account uuid := '70000000-0000-0000-0000-000000000001';
 claim uuid := '80000000-0000-0000-0000-000000000001';
 document uuid := '90000000-0000-0000-0000-000000000001';
 original_document bytea := convert_to(E'%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n', 'UTF8');
 old_time timestamptz := '2026-10-01T14:00:00.123456Z';
 frozen_coverage jsonb;
BEGIN
 INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date,created_at,identity_version)
 VALUES(tenant,patient,'2','Avery','Synthetic','1990-01-02',old_time,4),
       (second_tenant,second_patient,'2','Morgan','Synthetic','1980-03-04',old_time,2);
 INSERT INTO patient_identity_revisions(tenant_id,patient_id,version,snapshot,actor_id,reason,created_at)
 SELECT p.tenant_id,p.id,p.identity_version,to_jsonb(p),actor,'Historical synthetic identity',old_time
 FROM patients p;

 INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status,version,title,
                          category,facility,room,notes,request_id,request_digest)
 VALUES(tenant,appointment,patient,actor,old_time,old_time+interval '30 minutes','completed',6,
        'Synthetic follow-up','Office visit','Synthetic clinic','Room 2','Historical appointment',
        gen_random_uuid(),repeat('a',64));
 INSERT INTO appointment_revisions(tenant_id,appointment_id,version,snapshot,actor_id,reason,created_at)
 SELECT tenant,a.id,a.version,to_jsonb(a),actor,'Visit completed',old_time+interval '35 minutes'
 FROM appointments a WHERE a.id=appointment;
 INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,status,version,note,vitals,
                    signed_by,signed_at,created_at)
 VALUES(tenant,visit,patient,appointment,actor,'signed',7,
        '{"subjective":"Synthetic follow-up","objective":"Synthetic findings","assessment":"Synthetic assessment","plan":"Synthetic plan"}',
        '{"blood_pressure":"120/80","pulse":72}',actor,old_time+interval '32 minutes',old_time);
 INSERT INTO amendments(tenant_id,id,visit_id,author_id,reason,text,created_at)
 VALUES(tenant,gen_random_uuid(),visit,actor,'Historical clarification','Original signed text retained',old_time+interval '1 day');

 INSERT INTO ehr_payers(tenant_id,id,content,version,request_id,creation_hash)
 VALUES(tenant,payer,'{"name":"Synthetic Payer","payer_code":"SYN001","active":true}',3,gen_random_uuid(),repeat('b',64));
 INSERT INTO payer_revisions(tenant_id,payer_id,version,snapshot,actor_id,reason,created_at)
 SELECT tenant,p.id,p.version,to_jsonb(p),actor,'Historical payer',old_time FROM ehr_payers p WHERE p.id=payer;
 INSERT INTO insurance_coverages(tenant_id,id,patient_id,payer_id,content,version,request_id,creation_hash)
 VALUES(tenant,coverage,patient,payer,
        jsonb_build_object('payer_id',payer,'priority','primary','status','active','member_id','SYN-MEMBER-1',
                           'effective_date','2026-01-01','copay_cents',3000,'verification','manually_verified'),
        2,gen_random_uuid(),repeat('c',64));
 INSERT INTO coverage_revisions(tenant_id,coverage_id,version,snapshot,actor_id,reason,created_at)
 SELECT tenant,c.id,c.version,to_jsonb(c),actor,'Historical coverage',old_time
 FROM insurance_coverages c WHERE c.id=coverage;
 SELECT jsonb_build_object('coverage',to_jsonb(c),'payer',to_jsonb(p)) INTO frozen_coverage
 FROM insurance_coverages c JOIN ehr_payers p ON p.tenant_id=c.tenant_id AND p.id=c.payer_id
 WHERE c.id=coverage;
 INSERT INTO billing_accounts(tenant_id,id,patient_id,visit_id,coverage_id,content,coverage_snapshot,
                              total_cents,status,version,request_id,creation_hash,created_at,diagnosis_snapshot)
 VALUES(tenant,account,patient,visit,coverage,
        jsonb_build_object('visit_id',visit,'coverage_id',coverage,'service_date','2026-10-01',
                           'currency','USD','notes','Historical signed encounter charges',
                           'lines','[{"code_system":"CPT","code":"99213","description":"Synthetic office visit","units":1,"amount_cents":15000,"modifiers":"","diagnosis_codes":["M62.81"]}]'::jsonb),
        frozen_coverage,15000,'posted',5,gen_random_uuid(),repeat('d',64),old_time+interval '40 minutes',
        jsonb_build_object('visit_id',visit,'visit_version',7,'lines','[]'::jsonb));
 INSERT INTO billing_entries(tenant_id,id,account_id,kind,effect_cents,content,request_id,creation_hash,actor_id,created_at)
 VALUES(tenant,gen_random_uuid(),account,'payment',-3000,
        '{"party":"patient","method":"cash","reference":"SYN-COPAY-1","occurred_on":"2026-10-01","reason":"Historical copay"}',
        gen_random_uuid(),repeat('e',64),actor,old_time+interval '41 minutes'),
       (tenant,gen_random_uuid(),account,'payment',-10000,
        '{"party":"insurer","method":"external","reference":"SYN-EOB-1","occurred_on":"2026-10-15","reason":"Historical insurer payment"}',
        gen_random_uuid(),repeat('f',64),actor,old_time+interval '14 days');
 INSERT INTO billing_account_revisions(tenant_id,account_id,version,snapshot,actor_id,reason,created_at)
 SELECT tenant,a.id,a.version,to_jsonb(a),actor,'Historical posted charges',old_time+interval '40 minutes'
 FROM billing_accounts a WHERE a.id=account;
 INSERT INTO ehr_claims(tenant_id,id,patient_id,account_id,payer_id,control_number,frequency,content,snapshot,
                        status,version,payer_control_number,request_id,creation_hash,created_at)
 SELECT tenant,claim,patient,account,payer,'SYN-CLAIM-0001','original',
        '{"billing_provider":{"name":"Synthetic Clinic"},"diagnosis_codes":["M62.81"]}',
        jsonb_build_object('account',to_jsonb(a),'coverage',frozen_coverage),
        'accepted',4,'SYN-PAYER-CONTROL-1',gen_random_uuid(),repeat('1',64),old_time+interval '1 day'
 FROM billing_accounts a WHERE a.id=account;
 INSERT INTO claim_revisions(tenant_id,claim_id,version,snapshot,actor_id,reason,evidence,created_at)
 SELECT tenant,c.id,c.version,to_jsonb(c),actor,'Historical accepted claim',
        '{"source":"synthetic clearinghouse acknowledgment"}',old_time+interval '2 days'
 FROM ehr_claims c WHERE c.id=claim;

 INSERT INTO patient_documents(tenant_id,id,patient_id,request_id,create_request,version,content,filename,
                               content_type,bytes,sha256,size_bytes,uploaded_by,updated_by,uploaded_at,updated_at)
 VALUES(tenant,document,patient,gen_random_uuid(),'{"reason":"Original synthetic upload"}',3,
        jsonb_build_object('title','Synthetic insurance card','category','other','status','active',
                           'document_date','2026-10-01','visit_id',visit,'notes','Historical metadata'),
        'synthetic-insurance.pdf','application/pdf',original_document,encode(sha256(original_document),'hex'),
        octet_length(original_document),actor,actor,old_time,old_time+interval '1 day');
 INSERT INTO patient_document_revisions(tenant_id,document_id,version,content,actor_id,reason,created_at)
 SELECT tenant,d.id,1,d.content||'{"title":"Original synthetic card"}',actor,'Original synthetic upload',old_time
 FROM patient_documents d WHERE d.id=document;
 INSERT INTO patient_document_revisions(tenant_id,document_id,version,content,actor_id,reason,created_at)
 SELECT tenant,d.id,d.version,d.content,actor,'Historical metadata correction',old_time+interval '1 day'
 FROM patient_documents d WHERE d.id=document;
 INSERT INTO audit_events(tenant_id,actor_id,action,resource_id,created_at)
 VALUES(tenant,actor,'visit.signed',visit,old_time+interval '32 minutes'),
       (tenant,actor,'billing.account.posted',account,old_time+interval '40 minutes'),
       (tenant,actor,'claim.accepted',claim,old_time+interval '2 days'),
       (tenant,actor,'document.uploaded',document,old_time);
END $$;
"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT tablename::text FROM pg_tables WHERE schemaname=current_schema()
         AND tablename<>'_sqlx_migrations' ORDER BY tablename",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let before = snapshot_tables(&pool, &tables).await;
    for (table, count) in [
        ("patients", 2),
        ("patient_identity_revisions", 2),
        ("appointments", 1),
        ("appointment_revisions", 1),
        ("visits", 1),
        ("amendments", 1),
        ("ehr_payers", 1),
        ("payer_revisions", 1),
        ("insurance_coverages", 1),
        ("coverage_revisions", 1),
        ("billing_accounts", 1),
        ("billing_account_revisions", 1),
        ("billing_entries", 2),
        ("ehr_claims", 1),
        ("claim_revisions", 1),
        ("patient_documents", 1),
        ("patient_document_revisions", 2),
        ("audit_events", 4),
    ] {
        assert_eq!(before[table].0.as_array().unwrap().len(), count, "{table}");
    }
    let document_bytes: Vec<u8> = sqlx::query_scalar("SELECT bytes FROM patient_documents")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        before["patient_documents"].0[0]["sha256"],
        format!("{:x}", Sha256::digest(&document_bytes))
    );
    let migrations_before: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM _sqlx_migrations m",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    for pass in 1..=2 {
        // Second run is the supported migrator replay, not re-executing raw DDL.
        through_revision(91).run(&pool).await.unwrap();
        let after = snapshot_tables(&pool, &tables).await;
        assert_eq!(
            before, after,
            "existing row/byte hashes changed on pass {pass}"
        );
        let migrations: Value = sqlx::query_scalar(
            "SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM _sqlx_migrations m WHERE version<=88",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            migrations_before, migrations,
            "old migration history changed"
        );
        let versions: Vec<i64> = sqlx::query_scalar(
            "SELECT version FROM _sqlx_migrations WHERE version>88 AND success ORDER BY version",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(versions, [89, 90, 91]);
        for table in [
            "patient_invoice_snapshots",
            "billing_copay_receipts",
            "billing_copay_allocations",
            "billing_copay_voids",
        ] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(
                count, 0,
                "upgrade must not infer new financial rows in {table}"
            );
        }
        let balance: i64 = sqlx::query_scalar(
            "SELECT a.total_cents+coalesce(sum(e.effect_cents),0)::bigint FROM billing_accounts a
             LEFT JOIN billing_entries e ON e.tenant_id=a.tenant_id AND e.account_id=a.id
             GROUP BY a.tenant_id,a.id,a.total_cents",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(balance, 2000, "historical copay must not be applied twice");
    }
    // Existing manual receipts and older invoice formats must not become hosted
    // checkout operations, be reallocated, or be rewritten when schema 92 lands.
    sqlx::raw_sql(
        r#"
INSERT INTO billing_copay_receipts(tenant_id,id,patient_id,appointment_id,amount_cents,method,reference,occurred_on,reason,request_id,creation_hash,actor_id)
VALUES('10000000-0000-0000-0000-000000000001',gen_random_uuid(),'20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',1000,'external','SYN-EXTERNAL-RECEIPT','2026-10-01','Historical external payment',gen_random_uuid(),repeat('2',64),'30000000-0000-0000-0000-000000000001');
INSERT INTO patient_invoice_snapshots(tenant_id,id,patient_id,account_id,request_id,creation_hash,account_version,snapshot,actor_id)
VALUES('10000000-0000-0000-0000-000000000001',gen_random_uuid(),'20000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001',gen_random_uuid(),repeat('3',64),5,'{"gross_charges_cents":15000,"responsibility_cents":5000,"patient_credit_cents":3000,"amount_due_cents":2000,"currency":"USD"}','30000000-0000-0000-0000-000000000001');
"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let tables_91: Vec<String> = sqlx::query_scalar(
        "SELECT tablename::text FROM pg_tables WHERE schemaname=current_schema()
         AND tablename<>'_sqlx_migrations' ORDER BY tablename",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let before_hosted = snapshot_tables(&pool, &tables_91).await;
    assert_eq!(
        before_hosted["billing_copay_receipts"]
            .0
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        before_hosted["patient_invoice_snapshots"]
            .0
            .as_array()
            .unwrap()
            .len(),
        1
    );
    for _ in 0..2 {
        through_revision(92).run(&pool).await.unwrap();
        assert_eq!(before_hosted, snapshot_tables(&pool, &tables_91).await);
        for table in [
            "copay_checkout_attempts",
            "copay_checkout_events",
            "copay_checkout_refund_events",
            "copay_checkout_refund_allocations",
        ] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(
                count, 0,
                "hosted checkout upgrade must not backfill {table}"
            );
        }
    }
    let tables_92: Vec<String> = sqlx::query_scalar(
        "SELECT tablename::text FROM pg_tables WHERE schemaname=current_schema()
         AND tablename<>'_sqlx_migrations' ORDER BY tablename",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let before_files = snapshot_tables(&pool, &tables_92).await;
    for _ in 0..2 {
        through_revision(95).run(&pool).await.unwrap();
        assert_eq!(
            before_files,
            snapshot_tables(&pool, &tables_92).await,
            "file version upgrade must preserve original bytes, metadata and all financial rows"
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM patient_document_file_versions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "original documents must not be rewritten or backfilled as new versions"
        );
    }
    pool.close().await;
}
