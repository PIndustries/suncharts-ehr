// SPDX-License-Identifier: AGPL-3.0-only
//! Durable provider inbox: persist discoveries before advancing cursors; stage evidence, never infer clinical acceptance.
use crate::{
    auth::Actor,
    billing,
    delivery::{Adapter, Config, Route},
    error::{Error, Result},
    model::text,
    stedi, State,
};
use axum::{
    extract::{Path, State as ExtractState},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
fn core() -> String {
    stedi::CORE.into()
}
fn interval() -> i64 {
    60
}
fn hosts() -> Vec<String> {
    vec!["stedi-default-core-artifacts.s3.us-east-1.amazonaws.com".into()]
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub start_at: DateTime<Utc>,
    #[serde(default = "core")]
    pub core_base: String,
    #[serde(default = "interval")]
    pub interval_seconds: i64,
    #[serde(default = "hosts")]
    pub download_hosts: Vec<String>,
    #[serde(default)]
    pub claimmd_response_id: Option<String>,
}
impl Settings {
    pub fn validate(&self, r: &Route) -> Result<()> {
        if self.start_at > Utc::now() - chrono::Duration::minutes(1)
            || !(30..=86400).contains(&self.interval_seconds)
            || self.download_hosts.len() > 10
        {
            return Err(Error::Invalid("invalid retrieval start or interval"));
        }
        if r.adapter == Adapter::Stedi {
            let u = url::Url::parse(&self.core_base)
                .map_err(|_| Error::Invalid("invalid Stedi core base"))?;
            let local = r.loopback_test
                && u.origin()
                    == url::Url::parse(&r.endpoint)
                        .map_err(|_| Error::Invalid("invalid submit URL"))?
                        .origin()
                && u.query().is_none()
                && u.fragment().is_none()
                && u.username().is_empty()
                && u.password().is_none();
            if !local && self.core_base != stedi::CORE {
                return Err(Error::Invalid(
                    "Stedi core base must use the documented endpoint",
                ));
            }
            if self.download_hosts.iter().any(|h| {
                h.is_empty()
                    || !h.bytes().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-'
                    })
                    || !h.ends_with(".amazonaws.com")
            }) {
                return Err(Error::Invalid(
                    "Stedi download hosts must be explicit AWS artifact hosts",
                ));
            }
        }
        if self.claimmd_response_id.as_ref().is_some_and(|v| {
            v.is_empty()
                || v.len() > 20
                || !v.bytes().all(|c| c.is_ascii_digit())
                || v.parse::<u64>().is_err()
        }) {
            return Err(Error::Invalid("Claim.MD response cursor must be numeric"));
        }
        Ok(())
    }
}
pub(crate) struct Observation {
    pub remote_id: String,
    pub format: String,
    pub metadata: Value,
    pub status: String,
    pub inline: Option<String>,
}
pub(crate) struct Page {
    pub items: Vec<Observation>,
    pub next: Option<String>,
}
pub(crate) fn binding(r: &Route) -> String {
    let mut value = json!({"partner":r.partner_id,"usage":r.usage,"adapter":r.adapter,"endpoint":r.endpoint,"credential_ref":r.credential_env,"sftp":r.sftp,"core_base":r.retrieval.as_ref().map(|s|s.core_base.as_str()).unwrap_or(stedi::CORE)});
    if let Some(secret) = &r.credential_value {
        value["native_credential"] = json!(crate::oauth::hash(secret.expose()));
    }
    crate::oauth::hash(&value.to_string())
}

fn db(s: &State) -> Result<&PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
pub(crate) async fn connection_event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    key: &str,
    reason: &str,
    evidence: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO edi_connection_events (tenant_id,route_key,version,actor_id,reason,evidence) SELECT tenant_id,route_key,version,$3,$4,$5 FROM edi_connections WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(key).bind(a.sub).bind(reason).bind(evidence).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "edi.connection_change", a.tenant_id).await
}
async fn report_event(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    reason: &str,
    evidence: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO edi_remote_report_events (tenant_id,report_id,version,actor_id,reason,evidence) SELECT tenant_id,id,version,$3,$4,$5 FROM edi_remote_reports WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).bind(a.sub).bind(reason).bind(evidence).execute(&mut **tx).await?;
    crate::postgres::audit(tx, a, "edi.remote_report_change", id).await
}
pub(crate) async fn connection_paused(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    key: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT coalesce((SELECT paused FROM edi_connections WHERE tenant_id=$1 AND route_key=$2),false)").bind(a.tenant_id).bind(key).fetch_one(&mut **tx).await?)
}
pub(crate) async fn delivery_binding(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Route,
) -> Result<bool> {
    if r.adapter == Adapter::Gateway {
        return Ok(true);
    }
    ensure_connection(tx, a, r).await?;
    Ok(sqlx::query_scalar("SELECT binding_hash=$3 AND NOT paused FROM edi_connections WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(&r.key).bind(binding(r)).fetch_one(&mut **tx).await?)
}
async fn ensure_connection(tx: &mut Transaction<'_, Postgres>, a: &Actor, r: &Route) -> Result<()> {
    let start = r
        .retrieval
        .as_ref()
        .map(|v| v.start_at)
        .unwrap_or_else(|| Utc::now() - chrono::Duration::days(1));
    let count=sqlx::query("INSERT INTO edi_connections (tenant_id,route_key,partner_id,usage,adapter,binding_hash,start_at,paused,page_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING").bind(a.tenant_id).bind(&r.key).bind(r.partner_id).bind(&r.usage).bind(serde_json::to_value(r.adapter).unwrap().as_str().unwrap()).bind(binding(r)).bind(start).bind(false).bind(if r.adapter==Adapter::ClaimMd {Some(r.retrieval.as_ref().and_then(|s|s.claimmd_response_id.clone()).unwrap_or_else(||"0".into()))}else{None}).execute(&mut **tx).await?.rows_affected();
    if count > 0 {
        connection_event(tx,a,&r.key,"Operator provisioned provider connection",json!({"adapter":r.adapter,"usage":r.usage,"retrieval_configured":r.retrieval.is_some()})).await?;
    }
    Ok(())
}
pub async fn sync(pool: &PgPool, c: &Config) -> Result<()> {
    c.validate()?;
    for r in c.routes.iter().filter(|r| r.adapter != Adapter::Gateway) {
        let a = crate::delivery::worker(r.tenant_id);
        let mut tx = pool.begin().await?;
        billing::tenant_lock(&mut tx, &a).await?;
        // A route with a missing partner stays inactive without inventing a partner.
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM edi_partners WHERE tenant_id=$1 AND id=$2)",
        )
        .bind(a.tenant_id)
        .bind(r.partner_id)
        .fetch_one(&mut *tx)
        .await?;
        if exists {
            ensure_connection(&mut tx, &a, r).await?;
        }
        tx.commit().await?;
    }
    Ok(())
}
pub(crate) async fn insert_observation(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    key: &str,
    item: &Observation,
) -> Result<()> {
    let prior:Option<(String,Value)>=sqlx::query_as("SELECT format,metadata FROM edi_remote_reports WHERE tenant_id=$1 AND route_key=$2 AND remote_id=$3").bind(a.tenant_id).bind(key).bind(&item.remote_id).fetch_optional(&mut **tx).await?;
    if let Some((format, metadata)) = prior {
        if format != item.format || metadata != item.metadata {
            return Err(Error::Conflict(
                "provider reused a report identity with changed evidence",
            ));
        }
        return Ok(());
    }
    if item.remote_id.is_empty() || item.remote_id.len() > 200 {
        return Err(Error::Invalid("invalid provider report identity"));
    }
    let id = Uuid::new_v4();
    let (mut status, parsed) = if let Some(raw) = &item.inline {
        classify(raw, &item.format)
    } else {
        (item.status.clone(), json!({}))
    };
    if item.status == "quarantined" {
        status = "quarantined".into();
    }
    sqlx::query("INSERT INTO edi_remote_reports (tenant_id,id,route_key,remote_id,format,metadata,status,original_text,original_hash,parse_summary,last_result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(a.tenant_id).bind(id).bind(key).bind(&item.remote_id).bind(&item.format).bind(&item.metadata).bind(&status).bind(&item.inline).bind(item.inline.as_ref().map(|v|crate::oauth::hash(v))).bind(parsed).bind(if item.inline.is_some(){"original_received"}else{item.status.as_str()}).execute(&mut **tx).await?;
    report_event(
        tx,
        a,
        id,
        "Provider report discovered; no clinical status applied",
        json!({"route_key":key,"format":item.format,"status":status}),
    )
    .await
}
pub(crate) async fn initial_ack(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    r: &Route,
    v: &crate::stedi::Confirmation,
    submission: Uuid,
) -> Result<()> {
    ensure_connection(tx, a, r).await?;
    if let Some(raw) = &v.acknowledgment {
        insert_observation(tx,a,&r.key,&Observation{remote_id:format!("submission:{submission}"),format:"x12_277ca".into(),metadata:json!({"source":"stedi_submission_response","correlation_id":v.correlation,"submission_id":submission,"declared_origin":"clearinghouse"}),status:if raw.starts_with("ISA") && raw.as_bytes().get(102).is_some_and(|b|*b!=r.usage.as_bytes()[0]) {"quarantined"}else{"retrieved"}.into(),inline:Some(raw.clone())}).await?;
    }
    Ok(())
}
fn detect(raw: &str) -> &'static str {
    let (element, terminator) = if raw.starts_with("ISA") && raw.len() >= 106 {
        (raw.as_bytes()[3] as char, raw.as_bytes()[105] as char)
    } else {
        ('*', '~')
    };
    let transaction = raw.split(terminator).find_map(|segment| {
        let mut fields = segment.trim().split(element);
        if fields.next() == Some("ST") {
            fields.next()
        } else {
            None
        }
    });
    match transaction {
        Some("835") => "x12_835",
        Some("999") => "x12_999",
        Some("277") if raw.contains("005010X214") => "x12_277ca",
        _ if raw
            .split(terminator)
            .any(|s| s.trim().starts_with(&format!("TA1{element}"))) =>
        {
            "x12_ta1"
        }
        _ => "unsupported",
    }
}

fn classify(raw: &str, format: &str) -> (String, Value) {
    let result = match format {
        "x12_277ca" => crate::ca277::parse(raw).map(|d| json!(d)),
        "x12_unknown" => {
            let detected = detect(raw);
            let (status, parsed) = classify(raw, detected);
            return (status, json!({"detected_format":detected,"parsed":parsed}));
        }
        "claimmd_status" => serde_json::from_str::<Value>(raw)
            .map_err(|_| Error::Invalid("invalid Claim.MD evidence")),
        "x12_835"=>crate::era_file::parse(raw).map(|parts|json!({"requires_native_review":true,"transaction_count":parts.len(),"requires_batch":parts.len()>1,"claim_count":parts.iter().map(|p|p.document.claims.len()).sum::<usize>()})),
        "x12_999" | "x12_ta1" => {
            let expected = match format {
                "x12_999" => "ST*999*",
                _ => "TA1*",
            };
            if raw.contains(expected) {
                Ok(json!({"requires_native_review":true}))
            } else {
                Err(Error::Invalid(
                    "unexpected transaction type or delimiters; review original",
                ))
            }
        }
        _ => Err(Error::Invalid("unsupported provider document format")),
    };
    match result {
        Ok(v) => ("retrieved".into(), v),
        Err(_) => (
            "quarantined".into(),
            json!({"issue":"Original retained; unsupported or malformed document requires review"}),
        ),
    }
}
fn stedi_page(v: Value, usage: &str) -> Result<Page> {
    let next = v["nextPageToken"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 1024)
        .ok_or(Error::Invalid("provider cursor missing or oversized"))?
        .to_owned();
    let rows = v["items"]
        .as_array()
        .filter(|v| v.len() <= 500)
        .ok_or(Error::Invalid("invalid provider transaction page"))?;
    let mut items = vec![];
    for v in rows {
        let id = Uuid::parse_str(v["transactionId"].as_str().unwrap_or(""))
            .map_err(|_| Error::Invalid("invalid provider transaction ID"))?;
        let kind = v["x12"]["metadata"]["transaction"]["transactionSetIdentifier"]
            .as_str()
            .or(v["x12"]["transactionSetIdentifier"].as_str())
            .unwrap_or("");
        let format = match kind {
            "277" => "x12_277ca",
            "999" => "x12_999",
            "TA1" => "x12_ta1",
            "835" => "x12_835",
            _ => "unsupported",
        };
        let mode = v["mode"].as_str().unwrap_or("");
        let direction = v["direction"].as_str().unwrap_or("");
        let supported = v["status"] == "succeeded"
            && direction == "INBOUND"
            && mode == if usage == "T" { "test" } else { "production" }
            && format != "unsupported";
        // Do not retain artifact URLs or arbitrary response properties; discovery cannot choose a download destination.
        items.push(Observation{remote_id:id.to_string(),format:format.into(),metadata:json!({"transaction_id":id,"mode":mode,"direction":direction,"provider_status":v["status"],"transaction_type":kind}),status:if supported{"pending"}else{"ignored"}.into(),inline:None});
    }
    Ok(Page {
        items,
        next: Some(next),
    })
}
pub async fn poll_one(pool: &PgPool, c: &Config) -> Result<bool> {
    sync(pool, c).await?;
    let candidate:Option<(Uuid,String)>=sqlx::query_as("SELECT c.tenant_id,c.route_key FROM edi_connections c JOIN jsonb_to_recordset($1) cfg(tenant_id uuid,route_key text) ON cfg.tenant_id=c.tenant_id AND cfg.route_key=c.route_key WHERE NOT paused AND next_poll_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_poll_at,route_key LIMIT 1").bind(json!(c.routes.iter().filter(|r|r.retrieval.is_some()).map(|r|json!({"tenant_id":r.tenant_id,"route_key":r.key})).collect::<Vec<_>>())).fetch_optional(pool).await?;
    let Some((tenant, key)) = candidate else {
        return Ok(false);
    };
    let a = crate::delivery::worker(tenant);
    let Some(r) = c.route(tenant, &key).filter(|r| r.retrieval.is_some()) else {
        return Ok(false);
    };
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let row:Option<(String,Option<String>,DateTime<Utc>)>=sqlx::query_as("SELECT binding_hash,page_token,start_at FROM edi_connections WHERE tenant_id=$1 AND route_key=$2 AND NOT paused AND next_poll_at<=now() AND (lease_until IS NULL OR lease_until<now())").bind(tenant).bind(&key).fetch_optional(&mut *tx).await?;
    let Some((hash, token, start)) = row else {
        return Ok(false);
    };
    if hash != binding(r) {
        sqlx::query("UPDATE edi_connections SET paused=true,version=version+1,last_result='configuration_changed_use_new_route_key' WHERE tenant_id=$1 AND route_key=$2").bind(tenant).bind(&key).execute(&mut *tx).await?;
        connection_event(
            &mut tx,
            &a,
            &key,
            "Configuration changed; operator review required",
            json!({"cursor_advanced":false}),
        )
        .await?;
        tx.commit().await?;
        return Ok(true);
    }
    let lease = Uuid::new_v4();
    sqlx::query("UPDATE edi_connections SET lease_id=$3,lease_until=now()+interval '60 seconds',last_poll_at=now(),version=version+1 WHERE tenant_id=$1 AND route_key=$2").bind(tenant).bind(&key).bind(lease).execute(&mut *tx).await?;
    connection_event(
        &mut tx,
        &a,
        &key,
        "Provider polling leased",
        json!({"cursor_advanced":false}),
    )
    .await?;
    tx.commit().await?;
    let result = match r.adapter {
        Adapter::Stedi => stedi::page(r, token.as_deref(), start)
            .await
            .and_then(|v| stedi_page(v, &r.usage)),
        Adapter::ClaimMd => crate::claimmd::page(r, token.as_deref().unwrap_or("0")).await,
        Adapter::OfficeAllySftp | Adapter::AvailitySftp => crate::sftp_transport::page(r).await,
        _ => Err(Error::Invalid("unsupported retrieval adapter")),
    };
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let current:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_connections WHERE tenant_id=$1 AND route_key=$2 AND lease_id=$3)").bind(tenant).bind(&key).bind(lease).fetch_one(&mut *tx).await?;
    if !current {
        return Ok(true);
    }
    let ok = result.is_ok();
    if let Ok(page) = result {
        for item in &page.items {
            insert_observation(&mut tx, &a, &key, item).await?;
        }
        sqlx::query("UPDATE edi_connections SET page_token=$3,pages=pages+1,last_success_at=now() WHERE tenant_id=$1 AND route_key=$2").bind(tenant).bind(&key).bind(page.next).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE edi_connections SET lease_id=NULL,lease_until=NULL,next_poll_at=now()+make_interval(secs=>$3),last_result=$4,version=version+1 WHERE tenant_id=$1 AND route_key=$2").bind(tenant).bind(&key).bind(r.retrieval.as_ref().unwrap().interval_seconds as f64).bind(if ok{"page_persisted"}else{"poll_failed_cursor_retained"}).execute(&mut *tx).await?;
    connection_event(
        &mut tx,
        &a,
        &key,
        "Provider polling completed",
        json!({"cursor_advanced":ok}),
    )
    .await?;
    tx.commit().await?;
    Ok(true)
}
pub async fn fetch_one(pool: &PgPool, c: &Config) -> Result<bool> {
    let candidate:Option<(Uuid,Uuid)>=sqlx::query_as("SELECT r.tenant_id,r.id FROM edi_remote_reports r JOIN edi_connections conn ON conn.tenant_id=r.tenant_id AND conn.route_key=r.route_key JOIN jsonb_to_recordset($1) cfg(tenant_id uuid,route_key text,binding_hash text) ON cfg.tenant_id=conn.tenant_id AND cfg.route_key=conn.route_key AND cfg.binding_hash=conn.binding_hash WHERE NOT conn.paused AND ((r.status='pending' AND r.next_attempt_at<=now()) OR (r.status='leased' AND r.lease_until<now())) ORDER BY received_at,id LIMIT 1").bind(json!(c.routes.iter().filter(|r|r.retrieval.is_some()).map(|r|json!({"tenant_id":r.tenant_id,"route_key":r.key,"binding_hash":binding(r)})).collect::<Vec<_>>())).fetch_optional(pool).await?;
    let Some((tenant, id)) = candidate else {
        return Ok(false);
    };
    let a = crate::delivery::worker(tenant);
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let row:Option<(String,String,String)>=sqlx::query_as("SELECT route_key,remote_id,format FROM edi_remote_reports WHERE tenant_id=$1 AND id=$2 AND ((status='pending' AND next_attempt_at<=now()) OR (status='leased' AND lease_until<now()))").bind(tenant).bind(id).fetch_optional(&mut *tx).await?;
    let Some((key, remote, format)) = row else {
        return Ok(false);
    };
    let Some(r) = c.route(tenant, &key) else {
        return Ok(false);
    };
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edi_connections WHERE tenant_id=$1 AND route_key=$2 AND NOT paused AND binding_hash=$3)").bind(tenant).bind(&key).bind(binding(r)).fetch_one(&mut *tx).await?;
    if !valid {
        return Ok(false);
    }
    let lease = Uuid::new_v4();
    sqlx::query("UPDATE edi_remote_reports SET status='leased',lease_id=$3,lease_until=now()+interval '60 seconds',attempts=attempts+1,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(lease).execute(&mut *tx).await?;
    report_event(
        &mut tx,
        &a,
        id,
        "Read-only provider download leased",
        json!({"clinical_mutation":false}),
    )
    .await?;
    tx.commit().await?;
    let result = if r.adapter == Adapter::Stedi {
        match Uuid::parse_str(&remote) {
            Ok(id) => stedi::input(r, id).await,
            Err(_) => Err(Error::Invalid("invalid Stedi transaction ID")),
        }
    } else if r.adapter == Adapter::ClaimMd {
        crate::claimmd::era_input(r, &remote).await
    } else {
        crate::sftp_transport::input(r, &remote).await
    };
    let mut tx = pool.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let attempts:Option<i32>=sqlx::query_scalar("SELECT attempts FROM edi_remote_reports WHERE tenant_id=$1 AND id=$2 AND status='leased' AND lease_id=$3").bind(tenant).bind(id).bind(lease).fetch_optional(&mut *tx).await?;
    let Some(attempts) = attempts else {
        return Ok(true);
    };
    match result {
        Ok(raw) => {
            let (mut status, summary) = classify(&raw, &format);
            // Full envelopes carry mode; ST-only documents rely on the dedicated enrolled account/route.
            if raw.starts_with("ISA")
                && raw
                    .as_bytes()
                    .get(102)
                    .is_some_and(|v| *v != r.usage.as_bytes()[0])
            {
                status = "quarantined".into();
            }
            sqlx::query("UPDATE edi_remote_reports SET status=$3,original_text=$4,original_hash=$5,parse_summary=$6,last_result='original_downloaded',lease_id=NULL,lease_until=NULL,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(status).bind(&raw).bind(crate::oauth::hash(&raw)).bind(summary).execute(&mut *tx).await?;
        }
        Err(_) => {
            sqlx::query("UPDATE edi_remote_reports SET status=$3,last_result='download_failed',next_attempt_at=now()+interval '60 seconds',lease_id=NULL,lease_until=NULL,version=version+1 WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(id).bind(if attempts>=3{"quarantined"}else{"pending"}).execute(&mut *tx).await?;
        }
    }
    report_event(
        &mut tx,
        &a,
        id,
        "Provider download completed; native review required",
        json!({"clinical_mutation":false}),
    )
    .await?;
    tx.commit().await?;
    Ok(true)
}
pub async fn run(pool: PgPool, _c: Config) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        tick.tick().await;
        let c = match crate::provider_settings::load(&pool).await {
            Ok(c) => c,
            Err(_) => {
                eprintln!("Clearinghouse configuration unavailable; retrieval held");
                continue;
            }
        };
        if poll_one(&pool, &c).await.is_err() {
            eprintln!("Provider polling failed; durable cursor retained");
        }
        if crate::remittance_automation::poll_one(&pool, &c)
            .await
            .is_err()
        {
            eprintln!("ERA discovery failed; durable cursor retained");
        }
        if fetch_one(&pool, &c).await.is_err() {
            eprintln!("Provider retrieval failed; durable inbox requires inspection");
        }
        if crate::remittance_automation::stage_one(&pool, &c)
            .await
            .is_err()
        {
            eprintln!("ERA staging failed; original retained for review");
        }
    }
}
pub(crate) async fn verify(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    format: &str,
    raw: &str,
    partner: Option<Uuid>,
) -> Result<()> {
    let row:Option<(String,String,Option<Uuid>,Uuid)>=sqlx::query_as("SELECT coalesce(r.parse_summary->>'detected_format',r.format),r.status,r.native_id,c.partner_id FROM edi_remote_reports r JOIN edi_connections c ON c.tenant_id=r.tenant_id AND c.route_key=r.route_key WHERE r.tenant_id=$1 AND r.id=$2 AND r.original_text=$3").bind(a.tenant_id).bind(id).bind(raw).fetch_optional(&mut **tx).await?;
    let Some((f, status, native, p)) = row else {
        return Err(Error::NotFound);
    };
    if f != format || status != "retrieved" || native.is_some() || partner.is_some_and(|id| id != p)
    {
        return Err(Error::Conflict(
            "provider report requires unchanged original, correct partner and independent review",
        ));
    }
    Ok(())
}
pub(crate) async fn link(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    kind: &str,
    native: Uuid,
    reason: &str,
) -> Result<()> {
    link_evidence(tx, a, id, kind, native, reason, true).await
}
pub(crate) async fn link_evidence(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    id: Uuid,
    kind: &str,
    native: Uuid,
    reason: &str,
    reviewed: bool,
) -> Result<()> {
    sqlx::query("UPDATE edi_remote_reports SET native_kind=$3,native_id=$4,version=version+1 WHERE tenant_id=$1 AND id=$2 AND native_id IS NULL").bind(a.tenant_id).bind(id).bind(kind).bind(native).execute(&mut **tx).await?;
    report_event(
        tx,
        a,
        id,
        reason,
        json!({"native_kind":kind,"native_id":native,"explicit_review":reviewed}),
    )
    .await
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/v1/billing/connections", get(connections))
        .route("/api/v1/billing/connections/{key}", get(connection_detail))
        .route(
            "/api/v1/billing/connections/{key}/actions",
            post(connection_action),
        )
        .route("/api/v1/billing/retrieved-reports", get(reports))
        .route(
            "/api/v1/billing/retrieved-reports/from-source",
            post(from_source),
        )
        .route("/api/v1/billing/retrieved-reports/{id}", get(report_detail))
        .route(
            "/api/v1/billing/retrieved-reports/{id}/actions",
            post(report_action),
        )
}
async fn connections(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(c)-'tenant_id'-'binding_hash'-'page_token'-'lease_id' || jsonb_build_object('cursor_saved',page_token IS NOT NULL) FROM edi_connections c WHERE tenant_id=$1 ORDER BY route_key LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.connections_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items})))
}
async fn connection_detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let item:Value=sqlx::query_scalar("SELECT to_jsonb(c)-'tenant_id'-'binding_hash'-'page_token'-'lease_id' FROM edi_connections c WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(&key).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id' FROM edi_connection_events e WHERE tenant_id=$1 AND route_key=$2 ORDER BY version DESC LIMIT 100").bind(a.tenant_id).bind(&key).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.connection_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"connection":item,"events":events})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    action: String,
    reason: String,
    submission_id: Option<Uuid>,
    submission_version: Option<i64>,
    claim_version: Option<i64>,
}
async fn connection_action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(key): Path<String>,
    h: HeaderMap,
    Json(v): Json<Decision>,
) -> Result<Json<Value>> {
    if !matches!(a.role, crate::auth::Role::Owner) {
        return Err(Error::Forbidden);
    }
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    if !["pause", "resume", "poll_now"].contains(&v.action.as_str()) {
        return Err(Error::Invalid("unsupported connection action"));
    }
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let current: i64 = sqlx::query_scalar(
        "SELECT version FROM edi_connections WHERE tenant_id=$1 AND route_key=$2",
    )
    .bind(a.tenant_id)
    .bind(&key)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    if current != version {
        return Err(Error::Conflict("connection changed; reload"));
    }
    let historical:bool=sqlx::query_scalar("SELECT adapter='historical_import' FROM edi_connections WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(&key).fetch_one(&mut *tx).await?;
    if historical {
        return Err(Error::Conflict(
            "historical evidence cannot activate transport; provision a new enrolled route",
        ));
    }
    sqlx::query("UPDATE edi_connections SET paused=CASE WHEN $3='pause' THEN true WHEN $3='resume' THEN false ELSE paused END,next_poll_at=now(),version=version+1 WHERE tenant_id=$1 AND route_key=$2").bind(a.tenant_id).bind(&key).bind(&v.action).execute(&mut *tx).await?;
    connection_event(&mut tx, &a, &key, &v.reason, json!({"action":v.action})).await?;
    tx.commit().await?;
    Ok(Json(json!({"key":key,"version":version+1})))
}
async fn reports(a: Actor, ExtractState(s): ExtractState<State>) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id'-'original_text'-'metadata'-'parse_summary'-'lease_id' FROM edi_remote_reports r WHERE tenant_id=$1 ORDER BY received_at DESC,id LIMIT 100").bind(a.tenant_id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.remote_reports_read", a.tenant_id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"limit":100})))
}
async fn report_detail(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let item:Value=sqlx::query_scalar("SELECT to_jsonb(r)-'tenant_id'-'lease_id' FROM edi_remote_reports r WHERE tenant_id=$1 AND id=$2").bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e)-'tenant_id' FROM edi_remote_report_events e WHERE tenant_id=$1 AND report_id=$2 ORDER BY version DESC LIMIT 100").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.remote_report_read", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"report":item,"events":events})))
}
async fn report_action(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(v): Json<Decision>,
) -> Result<Json<Value>> {
    a.scheduling()?;
    text(&v.reason, 1000)?;
    let version = crate::expected(&h)?;
    if v.action == "link_status_evidence" {
        return link_status(a, s, id, version, v).await;
    }
    if v.action != "retry_download" {
        return Err(Error::Invalid("unsupported report action"));
    }
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let count=sqlx::query("UPDATE edi_remote_reports SET status='pending',next_attempt_at=now(),attempts=0,version=version+1 WHERE tenant_id=$1 AND id=$2 AND version=$3 AND status='quarantined' AND original_text IS NULL").bind(a.tenant_id).bind(id).bind(version).execute(&mut *tx).await?.rows_affected();
    if count == 0 {
        return Err(Error::Conflict(
            "reload; only failed downloads without original evidence can retry",
        ));
    }
    report_event(&mut tx, &a, id, &v.reason, json!({"action":v.action})).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"version":version+1})))
}

async fn link_status(
    a: Actor,
    s: State,
    id: Uuid,
    version: i64,
    v: Decision,
) -> Result<Json<Value>> {
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let row:Option<(String,i64)>=sqlx::query_as("SELECT original_text,version FROM edi_remote_reports WHERE tenant_id=$1 AND id=$2 AND format='claimmd_status' AND status='retrieved' AND native_id IS NULL").bind(a.tenant_id).bind(id).fetch_optional(&mut *tx).await?;
    let Some((raw, current)) = row else {
        return Err(Error::Conflict(
            "select an unlinked retrieved Claim.MD response",
        ));
    };
    if current != version {
        return Err(Error::Conflict("report changed; reload"));
    }
    let out = crate::clearinghouse::submission(
        &mut tx,
        &a,
        v.submission_id
            .ok_or(Error::Invalid("submission required"))?,
    )
    .await?;
    let c = crate::claims::claim_row(&mut tx, &a, out.claim_id).await?;
    if out.status != "delivered"
        || Some(out.version) != v.submission_version
        || Some(c.version) != v.claim_version
    {
        return Err(Error::Conflict(
            "review the current delivered submission and claim versions",
        ));
    }
    verify(
        &mut tx,
        &a,
        id,
        "claimmd_status",
        &raw,
        Some(out.partner_id),
    )
    .await?;
    let evidence: Value = serde_json::from_str(&raw)
        .map_err(|_| Error::Invalid("invalid stored provider evidence"))?;
    let account = &c.snapshot["account"];
    let content: crate::claims::ClaimContent =
        serde_json::from_value(c.content.clone()).map_err(|_| Error::Invalid("invalid claim"))?;
    let control = evidence["pcn"].as_str().unwrap_or("");
    let amount = format!(
        "{}.{:02}",
        account["total_cents"].as_i64().unwrap_or(0) / 100,
        account["total_cents"].as_i64().unwrap_or(0) % 100
    );
    if (control != c.control_number
        && (content.external_control_number.is_empty()
            || control != content.external_control_number))
        || evidence["bill_npi"] != content.billing_npi
        || evidence["bill_taxid"] != content.tax_id
        || evidence["ins_number"]
            != account["coverage_snapshot"]["coverage"]["content"]["member_id"]
        || evidence["payerid"] != account["coverage_snapshot"]["payer"]["content"]["payer_code"]
        || evidence["total_charge"] != amount
        || evidence["fdos"] != account["content"]["service_date"]
    {
        return Err(Error::Conflict(
            "provider control, billing identity, member, payer, amount or service date mismatch",
        ));
    }
    link(&mut tx, &a, id, "submission", out.id, &v.reason).await?;
    sqlx::query("UPDATE edi_submissions SET version=version+1 WHERE tenant_id=$1 AND id=$2")
        .bind(a.tenant_id)
        .bind(out.id)
        .execute(&mut *tx)
        .await?;
    crate::clearinghouse::event(&mut tx,&a,out.id,&v.reason,json!({"retrieved_report_id":id,"provider":"claim_md","clinical_status_changed":false,"status_evidence":evidence})).await?;
    // Evidence-only links still create a distinct submission event version.
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"native_id":out.id,"clinical_status_changed":false}),
    ))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Historical {
    request_id: Uuid,
    source_history_id: Uuid,
    partner_id: Uuid,
    reason: String,
}
async fn from_source(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Json(v): Json<Historical>,
) -> Result<Json<Value>> {
    if !matches!(a.role, crate::auth::Role::Owner) {
        return Err(Error::Forbidden);
    }
    text(&v.reason, 1000)?;
    let digest = crate::oauth::hash(
        &serde_json::to_string(&v).map_err(|_| Error::Invalid("invalid source mapping"))?,
    );
    let mut tx = db(&s)?.begin().await?;
    billing::tenant_lock(&mut tx, &a).await?;
    let prior:Option<(Uuid,String)>=sqlx::query_as("SELECT report_id,creation_hash FROM edi_remote_source_links WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(v.request_id).fetch_optional(&mut *tx).await?;
    if let Some((id, hash)) = prior {
        if hash != digest {
            return Err(Error::Conflict("source mapping request changed"));
        }
        return Ok(Json(json!({"id":id})));
    }
    let source:Value=sqlx::query_scalar("SELECT source_data FROM historical_records WHERE tenant_id=$1 AND id=$2 AND kind='edi_acknowledgment' AND patient_id IS NULL").bind(a.tenant_id).bind(v.source_history_id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    crate::clearinghouse::partner(&mut tx, &a, v.partner_id).await?;
    let format = source["format"]
        .as_str()
        .ok_or(Error::Invalid("source format missing"))?;
    if !["claimmd_status", "x12_277ca", "x12_999", "x12_ta1"].contains(&format) {
        return Err(Error::Invalid("unsupported source report format"));
    }
    let raw = source["original_text"]
        .as_str()
        .filter(|s| {
            (format == "claimmd_status" || s.is_ascii()) && !s.is_empty() && s.len() <= 48000
        })
        .ok_or(Error::Invalid("bounded original source text required"))?;
    if format == "claimmd_status" {
        if source["provider"] != "claim_md" {
            return Err(Error::Invalid(
                "Claim.MD provider identity must be declared",
            ));
        }
        let v: Value = serde_json::from_str(raw)
            .map_err(|_| Error::Invalid("invalid Claim.MD source JSON"))?;
        if crate::migration::contains_credentials(&v) {
            return Err(Error::Invalid(
                "credentials must be excluded from provider source JSON",
            ));
        }
    }
    let key = format!("historical-{}", v.source_history_id);
    sqlx::query("INSERT INTO edi_connections (tenant_id,route_key,partner_id,usage,adapter,binding_hash,start_at,paused,last_result) VALUES ($1,$2,$3,'T','historical_import','historical_only',now(),true,'historical_evidence_no_transport')").bind(a.tenant_id).bind(&key).bind(v.partner_id).execute(&mut *tx).await?;
    connection_event(
        &mut tx,
        &a,
        &key,
        &v.reason,
        json!({"historical_only":true,"transport_activated":false}),
    )
    .await?;
    let remote = format!("source:{}", v.source_history_id);
    insert_observation(&mut tx,&a,&key,&Observation{remote_id:remote.clone(),format:format.into(),metadata:json!({"source":"legacy_migration","source_history_id":v.source_history_id,"provider":source["provider"],"provider_report_id":source["provider_report_id"],"declared_origin":source["declared_origin"]}),status:"retrieved".into(),inline:Some(raw.into())}).await?;
    let id: Uuid = sqlx::query_scalar(
        "SELECT id FROM edi_remote_reports WHERE tenant_id=$1 AND route_key=$2 AND remote_id=$3",
    )
    .bind(a.tenant_id)
    .bind(&key)
    .bind(&remote)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO edi_remote_source_links (tenant_id,source_history_id,report_id,request_id,creation_hash,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)").bind(a.tenant_id).bind(v.source_history_id).bind(id).bind(v.request_id).bind(digest).bind(a.sub).bind(&v.reason).execute(&mut *tx).await?;
    crate::postgres::audit(&mut tx, &a, "edi.provider_source_map", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"transport_activated":false})))
}
