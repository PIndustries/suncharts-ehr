// SPDX-License-Identifier: AGPL-3.0-only
//! Immutable document originals with attributed, versioned metadata.
use crate::{
    auth::Actor,
    error::{Error, Result},
    model::text,
    postgres::audit,
    State,
};
use axum::{
    extract::{DefaultBodyLimit, Path, RawQuery, State as ExtractState},
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use std::collections::BTreeMap;
use uuid::Uuid;
const MAX_BYTES: usize = 10 * 1024 * 1024;
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Content {
    pub title: String,
    pub category: String,
    pub document_date: Option<NaiveDate>,
    pub visit_id: Option<Uuid>,
    #[serde(default)]
    pub notes: String,
    pub status: String,
}
impl Content {
    fn validate(&self) -> Result<()> {
        text(&self.title, 200)?;
        if ![
            "consult",
            "laboratory",
            "imaging",
            "consent",
            "referral",
            "other",
        ]
        .contains(&self.category.as_str())
            || !["active", "archived", "entered_in_error"].contains(&self.status.as_str())
            || self.notes.chars().count() > 10000
        {
            return Err(Error::Invalid("invalid document category, status or notes"));
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Upload {
    request_id: Uuid,
    filename: String,
    content_type: String,
    content_base64: String,
    content: Content,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    content: Content,
    reason: String,
}
#[derive(Serialize, sqlx::FromRow)]
struct Document {
    id: Uuid,
    patient_id: Uuid,
    version: i64,
    content: Value,
    filename: String,
    content_type: String,
    sha256: String,
    size_bytes: i64,
    uploaded_by: Uuid,
    uploader_label: Option<String>,
    updated_by: Uuid,
    uploaded_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
const FIELDS:&str="id,patient_id,version,content,filename,content_type,sha256,size_bytes,uploaded_by,(SELECT coalesce(nullif(u.display_name,''),u.email) FROM browser_users u WHERE u.tenant_id=patient_documents.tenant_id AND u.id=patient_documents.uploaded_by) AS uploader_label,updated_by,uploaded_at,updated_at";
pub fn routes() -> Router<State> {
    Router::new()
        .route(
            "/api/v1/patients/{patient}/documents",
            get(list)
                .post(upload)
                .layer(DefaultBodyLimit::max(15 * 1024 * 1024)),
        )
        .route(
            "/api/v1/patients/{patient}/documents/{id}",
            get(read).put(update),
        )
        .route(
            "/api/v1/patients/{patient}/documents/{id}/revisions",
            get(revisions),
        )
        .route(
            "/api/v1/patients/{patient}/documents/{id}/download",
            get(download),
        )
}
fn db(s: &State) -> Result<&sqlx::PgPool> {
    Ok(&s.browser.as_ref().ok_or(Error::NotFound)?.db)
}
async fn patient(tx: &mut Transaction<'_, Postgres>, a: &Actor, p: Uuid) -> Result<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM patients WHERE tenant_id=$1 AND id=$2)")
            .bind(a.tenant_id)
            .bind(p)
            .fetch_one(&mut **tx)
            .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    Ok(())
}
async fn context(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    c: &Content,
) -> Result<()> {
    patient(tx, a, p).await?;
    if let Some(visit) = c.visit_id {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM visits WHERE tenant_id=$1 AND patient_id=$2 AND id=$3)",
        )
        .bind(a.tenant_id)
        .bind(p)
        .bind(visit)
        .fetch_one(&mut **tx)
        .await?;
        if !exists {
            return Err(Error::Invalid("document visit must belong to this patient"));
        }
    }
    Ok(())
}
async fn row(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    p: Uuid,
    id: Uuid,
    lock: bool,
) -> Result<Document> {
    let q = format!(
        "SELECT {FIELDS} FROM patient_documents WHERE tenant_id=$1 AND patient_id=$2 AND id=$3{}",
        if lock { " FOR UPDATE" } else { "" }
    );
    sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(p)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)
}
pub(crate) async fn validate_link(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    patient: Uuid,
    id: Uuid,
) -> Result<Value> {
    let value: Option<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'version',version,'title',content->>'title','status',content->>'status','filename',filename,'content_type',content_type,'sha256',sha256,'size_bytes',size_bytes) FROM patient_documents WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 FOR SHARE")
      .bind(tenant).bind(patient).bind(id).fetch_optional(&mut **tx).await?;
    match value {
        Some(v) if v["status"] == "active" => Ok(v),
        Some(_) => Err(Error::Invalid(
            "referral attachments must be active patient documents",
        )),
        None => Err(Error::NotFound),
    }
}

fn response(v: Document) -> Response {
    let version = v.version;
    let mut r = Json(v).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{version}\"")).unwrap(),
    );
    r
}
async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let v = row(&mut tx, &a, p, id, false).await?;
    audit(&mut tx, &a, "patient.document.read", id).await?;
    tx.commit().await?;
    Ok(response(v))
}
async fn list(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut filters = BTreeMap::new();
    for (k, v) in url::form_urlencoded::parse(raw.as_deref().unwrap_or("").as_bytes()) {
        if !["_count", "_after", "category", "status"].contains(&k.as_ref())
            || filters.insert(k.into_owned(), v.into_owned()).is_some()
        {
            return Err(Error::Invalid("unsupported or repeated document filter"));
        }
    }
    let count: i64 = filters
        .get("_count")
        .map(|v| v.parse())
        .transpose()
        .map_err(|_| Error::Invalid("invalid document page size"))?
        .unwrap_or(50);
    if !(1..=100).contains(&count) {
        return Err(Error::Invalid("document page size must be 1 to 100"));
    }
    let after = filters
        .get("_after")
        .map(|v| Uuid::parse_str(v))
        .transpose()
        .map_err(|_| Error::Invalid("invalid document cursor"))?;
    let category = filters.get("category");
    let status = filters.get("status");
    if category.is_some_and(|v| {
        ![
            "consult",
            "laboratory",
            "imaging",
            "consent",
            "referral",
            "other",
        ]
        .contains(&v.as_str())
    }) || status
        .is_some_and(|v| !["active", "archived", "entered_in_error"].contains(&v.as_str()))
    {
        return Err(Error::Invalid("unsupported document filter value"));
    }
    let mut tx = db(&s)?.begin().await?;
    patient(&mut tx, &a, p).await?;
    let q=format!("SELECT {FIELDS} FROM patient_documents WHERE tenant_id=$1 AND patient_id=$2 AND ($3::text IS NULL OR content->>'category'=$3) AND ($4::text IS NULL OR content->>'status'=$4) AND ($5::uuid IS NULL OR id>$5) ORDER BY id LIMIT $6");
    let mut items: Vec<Document> = sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(p)
        .bind(category)
        .bind(status)
        .bind(after)
        .bind(count + 1)
        .fetch_all(&mut *tx)
        .await?;
    let more = items.len() > count as usize;
    items.truncate(count as usize);
    let cursor = if more {
        items.last().map(|v| v.id)
    } else {
        None
    };
    audit(&mut tx, &a, "patient.document.list", p).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":cursor})))
}
fn file_bytes(v: &Upload) -> Result<Vec<u8>> {
    text(&v.filename, 255)?;
    if v.filename
        .chars()
        .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(Error::Invalid(
            "document filename must not contain paths or control characters",
        ));
    }
    if v.content_base64.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err(Error::Invalid("document exceeds 10 MiB"));
    }
    let bytes = STANDARD
        .decode(&v.content_base64)
        .map_err(|_| Error::Invalid("invalid document base64"))?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(Error::Invalid("document must contain 1 byte to 10 MiB"));
    }
    let magic = match v.content_type.as_str() {
        "application/pdf" => bytes.starts_with(b"%PDF-") && bytes.windows(5).any(|v| v == b"%%EOF"),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff") && bytes.ends_with(b"\xff\xd9"),
        _ => false,
    };
    if !magic {
        return Err(Error::Invalid(
            "only PDF, PNG or JPEG with matching file signatures are accepted",
        ));
    }
    Ok(bytes)
}
async fn revision(
    tx: &mut Transaction<'_, Postgres>,
    a: &Actor,
    v: &Document,
    reason: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO patient_document_revisions(tenant_id,document_id,version,content,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6)").bind(a.tenant_id).bind(v.id).bind(v.version).bind(&v.content).bind(a.sub).bind(reason.trim()).execute(&mut **tx).await?;
    Ok(())
}
async fn upload(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path(p): Path<Uuid>,
    Json(v): Json<Upload>,
) -> Result<Response> {
    a.clinical()?;
    v.content.validate()?;
    text(&v.reason, 1000)?;
    if v.content.status != "active" {
        return Err(Error::Invalid("new documents must be active"));
    }
    let bytes = file_bytes(&v)?;
    let hash = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let original = json!({"patient_id":p,"filename":v.filename,"content_type":v.content_type,"sha256":hash,"content":v.content,"reason":v.reason});
    let mut tx = db(&s)?.begin().await?;
    context(&mut tx, &a, p, &v.content).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("{}:document:{}", a.tenant_id, v.request_id))
        .execute(&mut *tx)
        .await?;
    let prior: Option<(Uuid, Value)> = sqlx::query_as(
        "SELECT id,create_request FROM patient_documents WHERE tenant_id=$1 AND request_id=$2",
    )
    .bind(a.tenant_id)
    .bind(v.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((id, old)) = prior {
        if old != original {
            return Err(Error::Conflict(
                "request identity already used for another document",
            ));
        }
        let v = row(&mut tx, &a, p, id, false).await?;
        audit(&mut tx, &a, "patient.document.replay", id).await?;
        tx.commit().await?;
        return Ok(response(v));
    }
    let q=format!("INSERT INTO patient_documents(tenant_id,id,patient_id,request_id,create_request,content,filename,content_type,bytes,sha256,size_bytes,uploaded_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING {FIELDS}");
    let entry = sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(Uuid::new_v4())
        .bind(p)
        .bind(v.request_id)
        .bind(original)
        .bind(json!(v.content))
        .bind(v.filename)
        .bind(v.content_type)
        .bind(&bytes)
        .bind(hash)
        .bind(bytes.len() as i64)
        .bind(a.sub)
        .fetch_one(&mut *tx)
        .await?;
    revision(&mut tx, &a, &entry, &v.reason).await?;
    audit(&mut tx, &a, "patient.document.upload", entry.id).await?;
    tx.commit().await?;
    Ok(response(entry))
}
async fn update(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(v): Json<Change>,
) -> Result<Response> {
    a.clinical()?;
    v.content.validate()?;
    text(&v.reason, 1000)?;
    let expected = crate::expected(&h)?;
    let mut tx = db(&s)?.begin().await?;
    let old = row(&mut tx, &a, p, id, true).await?;
    if old.version != expected {
        return Err(Error::Conflict(
            "document metadata changed; compare saved record before editing",
        ));
    }
    context(&mut tx, &a, p, &v.content).await?;
    let q=format!("UPDATE patient_documents SET content=$4,version=version+1,updated_by=$5,updated_at=now() WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 RETURNING {FIELDS}");
    let entry = sqlx::query_as(&q)
        .bind(a.tenant_id)
        .bind(p)
        .bind(id)
        .bind(json!(v.content))
        .bind(a.sub)
        .fetch_one(&mut *tx)
        .await?;
    revision(&mut tx, &a, &entry, &v.reason).await?;
    audit(&mut tx, &a, "patient.document.update", id).await?;
    tx.commit().await?;
    Ok(response(entry))
}
async fn revisions(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    row(&mut tx, &a, p, id, false).await?;
    let mut items=sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('version',version,'content',content,'actor_id',actor_id,'actor_label',(SELECT coalesce(nullif(u.display_name,''),u.email) FROM browser_users u WHERE u.tenant_id=r.tenant_id AND u.id=r.actor_id),'reason',reason,'created_at',created_at) FROM patient_document_revisions r WHERE tenant_id=$1 AND document_id=$2 ORDER BY version DESC LIMIT 101").bind(a.tenant_id).bind(id).fetch_all(&mut *tx).await?;
    let truncated = items.len() > 100;
    items.truncate(100);
    audit(&mut tx, &a, "patient.document.revisions", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"truncated":truncated})))
}
async fn download(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let v = row(&mut tx, &a, p, id, false).await?;
    let bytes: Vec<u8> = sqlx::query_scalar(
        "SELECT bytes FROM patient_documents WHERE tenant_id=$1 AND patient_id=$2 AND id=$3",
    )
    .bind(a.tenant_id)
    .bind(p)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    audit(&mut tx, &a, "patient.document.download", id).await?;
    tx.commit().await?;
    let ext = match v.content_type.as_str() {
        "application/pdf" => "pdf",
        "image/png" => "png",
        _ => "jpg",
    };
    let mut r = ([(header::CONTENT_TYPE, v.content_type)], bytes).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"document-{id}.{ext}\"")).unwrap(),
    );
    r.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(r)
}
