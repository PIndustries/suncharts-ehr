// SPDX-License-Identifier: AGPL-3.0-only
//! Append-only working copies. Version 1 always refers to the immutable upload.
use super::*;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Annotation {
    id: Uuid,
    page: u32,
    kind: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    text: String,
    color: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    request_id: Uuid,
    #[serde(default)]
    text_content: Option<String>,
    #[serde(default)]
    content_base64: Option<String>,
    annotations: Vec<Annotation>,
    reason: String,
}
#[derive(sqlx::FromRow)]
struct FileRow {
    version: i64,
    filename: String,
    content_type: String,
    storage: String,
    bytes: Option<Vec<u8>>,
    object_key: Option<String>,
    sha256: String,
    size_bytes: i64,
    annotations: Value,
    actor_id: Uuid,
    created_at: DateTime<Utc>,
    reason: String,
}
struct FileVersion {
    version: i64,
    filename: String,
    content_type: String,
    bytes: Vec<u8>,
    sha256: String,
    size_bytes: i64,
    annotations: Value,
    actor_id: Uuid,
    created_at: DateTime<Utc>,
    reason: String,
}
const SELECT_VERSION: &str = "SELECT version,filename,content_type,storage,bytes,object_key,sha256,size_bytes,annotations,actor_id,created_at,reason FROM patient_document_file_versions WHERE tenant_id=$1 AND patient_id=$2 AND document_id=$3 AND version=$4 UNION ALL SELECT 1,filename,content_type,storage,bytes,object_key,sha256,size_bytes,'[]'::jsonb,uploaded_by,uploaded_at,coalesce(create_request->>'reason','Original upload') FROM patient_documents WHERE tenant_id=$1 AND patient_id=$2 AND id=$3 AND $4=1";
pub(super) fn routes() -> Router<State> {
    Router::new()
        .route("/vendor/pdfjs/standard_fonts/{name}", get(standard_font))
        .route(
            "/api/v1/patients/{patient}/documents/{id}/files",
            get(list)
                .post(save)
                .layer(DefaultBodyLimit::max(15 * 1024 * 1024)),
        )
        .route(
            "/api/v1/patients/{patient}/documents/{id}/files/{version}",
            get(read),
        )
        .route(
            "/api/v1/patients/{patient}/documents/{id}/files/{version}/preview",
            get(preview),
        )
        .route(
            "/api/v1/patients/{patient}/documents/{id}/files/{version}/download",
            get(download),
        )
}
async fn load(
    tx: &mut Transaction<'_, Postgres>,
    store: &DocumentStore,
    a: &Actor,
    p: Uuid,
    id: Uuid,
    version: i64,
) -> Result<FileVersion> {
    let row: FileRow = sqlx::query_as(SELECT_VERSION)
        .bind(a.tenant_id)
        .bind(p)
        .bind(id)
        .bind(version)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
    let bytes = store
        .load(
            a.tenant_id,
            id,
            row.version,
            Stored {
                storage: row.storage,
                bytes: row.bytes,
                object_key: row.object_key,
                sha256: row.sha256.clone(),
                size_bytes: row.size_bytes,
            },
        )
        .await?;
    Ok(FileVersion {
        version: row.version,
        filename: row.filename,
        content_type: row.content_type,
        bytes,
        sha256: row.sha256,
        size_bytes: row.size_bytes,
        annotations: row.annotations,
        actor_id: row.actor_id,
        created_at: row.created_at,
        reason: row.reason,
    })
}
fn public(v: &FileVersion) -> Value {
    json!({"version":v.version,"filename":v.filename,"content_type":v.content_type,"sha256":v.sha256,"size_bytes":v.size_bytes,"annotations":v.annotations,"actor_id":v.actor_id,"created_at":v.created_at,"reason":v.reason,"text_content":if v.content_type=="text/plain" {std::str::from_utf8(&v.bytes).ok()} else {None}})
}
async fn list(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let d = row(&mut tx, &a, p, id, false).await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('version',version,'filename',filename,'content_type',content_type,'sha256',sha256,'size_bytes',size_bytes,'actor_id',actor_id,'actor_label',(SELECT coalesce(nullif(u.display_name,''),u.email) FROM browser_users u WHERE u.tenant_id=f.tenant_id AND u.id=f.actor_id),'created_at',created_at,'reason',reason,'annotation_count',jsonb_array_length(annotations)) FROM patient_document_file_versions f WHERE tenant_id=$1 AND patient_id=$2 AND document_id=$3 ORDER BY version DESC LIMIT 100")
        .bind(a.tenant_id).bind(p).bind(id).fetch_all(&mut *tx).await?;
    let truncated = items.len() == 100 && d.file_version > 101;
    items.push(json!({"version":1,"filename":d.filename,"content_type":d.content_type,"sha256":d.sha256,"size_bytes":d.size_bytes,"actor_id":d.uploaded_by,"actor_label":d.uploader_label,"created_at":d.uploaded_at,"reason":"Original upload","annotation_count":0}));
    audit(&mut tx, &a, "patient.document.files_list", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":items,"latest_version":d.file_version,"truncated":truncated}),
    ))
}
async fn read(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id, version)): Path<(Uuid, Uuid, i64)>,
) -> Result<Json<Value>> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let v = load(&mut tx, store(&s)?, &a, p, id, version).await?;
    audit(&mut tx, &a, "patient.document.file_read", id).await?;
    tx.commit().await?;
    Ok(Json(public(&v)))
}
fn validate_annotations(items: &[Annotation], content_type: &str) -> Result<()> {
    if items.len() > 500
        || (!items.is_empty()
            && !matches!(content_type, "application/pdf" | "image/png" | "image/jpeg"))
    {
        return Err(Error::Invalid(
            "annotations require PDF/image content and at most 500 marks",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for n in items {
        if !ids.insert(n.id)
            || n.page == 0
            || n.page > 10_000
            || (content_type != "application/pdf" && n.page != 1)
            || !["highlight", "rectangle", "note"].contains(&n.kind.as_str())
            || !["yellow", "blue", "red"].contains(&n.color.as_str())
            || n.text.chars().count() > 2000
            || [n.x, n.y, n.width, n.height]
                .iter()
                .any(|x| !x.is_finite() || *x < 0.0 || *x > 1.0)
            || n.width == 0.0
            || n.height == 0.0
            || n.x + n.width > 1.000001
            || n.y + n.height > 1.000001
        {
            return Err(Error::Invalid("invalid page annotation"));
        }
    }
    Ok(())
}
async fn save(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(v): Json<Save>,
) -> Result<Json<Value>> {
    let expected = crate::expected(&headers)?;
    let mut tx = db(&s)?.begin().await?;
    let saved = save_in_transaction(&mut tx, store(&s)?, &a, p, id, expected, v).await?;
    tx.commit().await?;
    Ok(Json(saved))
}
async fn save_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    store: &DocumentStore,
    a: &Actor,
    p: Uuid,
    id: Uuid,
    expected: i64,
    v: Save,
) -> Result<Value> {
    text(&v.reason, 1000)?;
    let d = row(tx, a, p, id, true).await?;
    write_document(a, d.content["category"].as_str().unwrap_or_default())?;
    if d.content["status"] != "active" {
        return Err(Error::Conflict(
            "only active documents accept new file versions",
        ));
    }
    let base = load(tx, store, a, p, id, expected).await?;
    validate_annotations(&v.annotations, &base.content_type)?;
    if v.text_content.is_some() && v.content_base64.is_some() {
        return Err(Error::Invalid(
            "provide text or binary file content, not both",
        ));
    }
    let bytes = if let Some(value) = &v.text_content {
        if base.content_type != "text/plain" {
            return Err(Error::Invalid(
                "plain text editing cannot replace another file format",
            ));
        }
        value.as_bytes().to_vec()
    } else if let Some(encoded) = &v.content_base64 {
        if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
            return Err(Error::Invalid("document exceeds 10 MiB"));
        }
        STANDARD
            .decode(encoded)
            .map_err(|_| Error::Invalid("invalid file base64"))?
    } else {
        base.bytes
    };
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(Error::Invalid("document must contain 1 byte to 10 MiB"));
    }
    validate_file_type(&base.content_type, &bytes)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let annotations = json!(v.annotations);
    let request_hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&json!({"patient":p,"document":id,"base_version":expected,"sha256":hash,"annotations":annotations,"reason":v.reason})).map_err(|_|Error::Invalid("invalid file version"))?));
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("{}:file-version:{}", a.tenant_id, v.request_id))
        .execute(&mut **tx)
        .await?;
    let previous:Option<(Uuid,i64,String)>=sqlx::query_as("SELECT document_id,version,request_hash FROM patient_document_file_versions WHERE tenant_id=$1 AND request_id=$2").bind(a.tenant_id).bind(v.request_id).fetch_optional(&mut **tx).await?;
    if let Some((old_id, version, digest)) = previous {
        if old_id != id || digest != request_hash {
            return Err(Error::Conflict(
                "request ID already used for another file version",
            ));
        }
        let saved = load(tx, store, a, p, id, version).await?;
        audit(tx, a, "patient.document.file_replayed", id).await?;
        return Ok(public(&saved));
    }
    // The parent lock serializes metadata, file saves and provider callbacks.
    // Re-read the maximum after taking that lock: an earlier snapshot may be stale.
    let current:i64=sqlx::query_scalar("SELECT coalesce(max(version),1) FROM patient_document_file_versions WHERE tenant_id=$1 AND document_id=$2").bind(a.tenant_id).bind(id).fetch_one(&mut **tx).await?;
    if expected != current {
        return Err(Error::Conflict(
            "file changed; review the latest version before saving",
        ));
    }
    // A replay returned above. The version number is fixed under the parent
    // row lock, so the sealed file is stored and confirmed before its row.
    let object_key = if store.is_remote() {
        Some(
            store
                .save(a.tenant_id, id, current + 1, &hash, &bytes, false)
                .await?,
        )
    } else {
        None
    };
    let inserted = sqlx::query("INSERT INTO patient_document_file_versions(tenant_id,document_id,patient_id,version,request_id,request_hash,filename,content_type,bytes,sha256,size_bytes,annotations,actor_id,reason,storage,object_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)")
        .bind(a.tenant_id).bind(id).bind(p).bind(current+1).bind(v.request_id).bind(request_hash).bind(base.filename).bind(base.content_type).bind(object_key.is_none().then_some(&bytes[..])).bind(hash).bind(bytes.len() as i64).bind(annotations).bind(a.sub).bind(v.reason.trim()).bind(if object_key.is_some() { "s3" } else { "database" }).bind(&object_key).execute(&mut **tx).await;
    if let (Err(_), Some(key)) = (&inserted, &object_key) {
        // Harmless: nothing refers to it and it is never listed.
        eprintln!("file version was not recorded; stored object {key} is unreferenced");
    }
    inserted?;
    let saved = load(tx, store, a, p, id, current + 1).await?;
    audit(tx, a, "patient.document.file_saved", id).await?;
    Ok(public(&saved))
}
/// The Office bridge must validate its scoped capability and the actor's current
/// access policy before calling these helpers. All effects share its transaction.
pub(crate) struct OfficeSource {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub version: i64,
}
pub(crate) async fn office_source(
    tx: &mut Transaction<'_, Postgres>,
    store: &DocumentStore,
    a: &Actor,
    p: Uuid,
    id: Uuid,
    version: i64,
) -> Result<OfficeSource> {
    a.staff()?;
    let file = load(tx, store, a, p, id, version).await?;
    if !file
        .content_type
        .starts_with("application/vnd.openxmlformats")
    {
        return Err(Error::Invalid(
            "Office editor supports DOCX and XLSX files only",
        ));
    }
    audit(tx, a, "patient.document.office_source", id).await?;
    Ok(OfficeSource {
        filename: file.filename,
        content_type: file.content_type,
        bytes: file.bytes,
        sha256: file.sha256,
        version: file.version,
    })
}
#[allow(clippy::too_many_arguments)]
pub(crate) async fn append_office_file(
    tx: &mut Transaction<'_, Postgres>,
    store: &DocumentStore,
    a: &Actor,
    p: Uuid,
    id: Uuid,
    expected: i64,
    request_id: Uuid,
    bytes: Vec<u8>,
) -> Result<Value> {
    let source = load(tx, store, a, p, id, expected).await?;
    if !source
        .content_type
        .starts_with("application/vnd.openxmlformats")
    {
        return Err(Error::Invalid(
            "Office editor supports DOCX and XLSX files only",
        ));
    }
    save_in_transaction(
        tx,
        store,
        a,
        p,
        id,
        expected,
        Save {
            request_id,
            text_content: None,
            content_base64: Some(STANDARD.encode(bytes)),
            annotations: Vec::new(),
            reason: "Saved in Office editor".into(),
        },
    )
    .await
}

async fn preview(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id, version)): Path<(Uuid, Uuid, i64)>,
) -> Result<Response> {
    file(a, s, p, id, version, true).await
}
async fn download(
    a: Actor,
    ExtractState(s): ExtractState<State>,
    Path((p, id, version)): Path<(Uuid, Uuid, i64)>,
) -> Result<Response> {
    file(a, s, p, id, version, false).await
}
async fn file(
    a: Actor,
    s: State,
    p: Uuid,
    id: Uuid,
    version: i64,
    inline: bool,
) -> Result<Response> {
    a.staff()?;
    let mut tx = db(&s)?.begin().await?;
    let v = load(&mut tx, store(&s)?, &a, p, id, version).await?;
    let office = v.content_type.starts_with("application/vnd.openxmlformats");
    if inline && office {
        return Err(Error::Invalid(
            "Office files require the configured Office editor or download",
        ));
    }
    audit(
        &mut tx,
        &a,
        if inline {
            "patient.document.file_preview"
        } else {
            "patient.document.file_download"
        },
        id,
    )
    .await?;
    tx.commit().await?;
    let extension = v
        .filename
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .filter(|extension| {
            extension.len() <= 8 && extension.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or("bin")
        .to_owned();
    let mut response = ([(header::CONTENT_TYPE, v.content_type)], v.bytes).into_response();
    let h = response.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "{}; filename=\"file-{id}-v{version}.{extension}\"",
            if inline { "inline" } else { "attachment" }
        ))
        .unwrap(),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        ),
    );
    h.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("SAMEORIGIN"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    Ok(response)
}

async fn standard_font(Path(name): Path<String>) -> Result<Response> {
    let bytes: &'static [u8] = match name.as_str() {
        "FoxitDingbats.pfb" => {
            include_bytes!("../../web/vendor/pdfjs/standard_fonts/FoxitDingbats.pfb")
        }
        "LiberationSans-Bold.ttf" => {
            include_bytes!("../../web/vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf")
        }
        "FoxitSymbol.pfb" => {
            include_bytes!("../../web/vendor/pdfjs/standard_fonts/FoxitSymbol.pfb")
        }
        "LiberationSans-BoldItalic.ttf" => {
            include_bytes!("../../web/vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf")
        }
        "FoxitFixedBoldItalic.pfb" => {
            include_bytes!("../../web/vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb")
        }
        "FoxitFixedItalic.pfb" => {
            include_bytes!("../../web/vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb")
        }
        "FoxitSerifItalic.pfb" => {
            include_bytes!("../../web/vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb")
        }
        "FoxitSerifBoldItalic.pfb" => {
            include_bytes!("../../web/vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb")
        }
        "FoxitSerifBold.pfb" => {
            include_bytes!("../../web/vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb")
        }
        "FoxitFixed.pfb" => include_bytes!("../../web/vendor/pdfjs/standard_fonts/FoxitFixed.pfb"),
        "LiberationSans-Italic.ttf" => {
            include_bytes!("../../web/vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf")
        }
        "FoxitSerif.pfb" => include_bytes!("../../web/vendor/pdfjs/standard_fonts/FoxitSerif.pfb"),
        "LiberationSans-Regular.ttf" => {
            include_bytes!("../../web/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf")
        }
        "FoxitFixedBold.pfb" => {
            include_bytes!("../../web/vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb")
        }
        _ => return Err(Error::NotFound),
    };
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}
