// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic data only. Model bake-off for "suggest codes from the note": the real pipeline
// (request, lookup, choose, post-filters) runs end to end against an OpenAI-compatible endpoint,
// one note at a time. It is ignored by default and needs a model server:
//
//   BAKEOFF_BASE=http://127.0.0.1:11435 BAKEOFF_MODEL=name BAKEOFF_OUT=/path/out.jsonl \
//   TEST_DATABASE_URL=... cargo test model_bakeoff -- --ignored --nocapture
//
// Optional: BAKEOFF_ONLY=id1,id2 limits the notes. One JSON line per note is printed and, when
// BAKEOFF_OUT is set, appended to that file. The notes and what they should yield live in
// local_ai_bakeoff_notes.json; the practice's procedure list below is synthetic.
use super::*;
use std::time::{Duration, Instant};

const NOTES: &str = include_str!("local_ai_bakeoff_notes.json");

/// The practice's own procedure list: invented codes and plain wording, nothing licensed.
const PRACTICE_LIST: &[(&str, &str)] = &[
    (
        "SYN-A01",
        "Botulinum toxin injection, neck and shoulder muscles",
    ),
    (
        "SYN-A02",
        "Botulinum toxin injection, head and face muscles",
    ),
    (
        "SYN-A03",
        "Botulinum toxin injection, chronic migraine protocol",
    ),
    ("SYN-B01", "Joint injection, large joint"),
    ("SYN-B02", "Joint injection, small joint"),
    ("SYN-B03", "Trigger point injection, one or two muscles"),
    ("SYN-B04", "Trigger point injection, three or more muscles"),
    ("SYN-B05", "Nerve block injection, head and neck"),
    ("SYN-C01", "Point of care hemoglobin A1c test"),
    ("SYN-C02", "Urinalysis, dipstick"),
    ("SYN-C03", "Blood draw by needle"),
    ("SYN-D01", "Electrocardiogram, 12 lead, with report"),
    ("SYN-D02", "Chest X-ray, two views"),
    ("SYN-D03", "Nebulizer breathing treatment"),
    ("SYN-E01", "Psychotherapy session, 30 minutes"),
    ("SYN-E02", "Psychotherapy session, 45 minutes"),
    ("SYN-F01", "Shave removal of a skin lesion"),
    ("SYN-F02", "Wound care and dressing"),
];

/// What Connect's worker sends upstream for a chat job: model, messages, temperature,
/// max_tokens, stream off, and a JSON response format when the job asks for JSON.
fn upstream(model: &str, job: &Value) -> Value {
    let mut b = json!({
        "model": model, "messages": job["messages"],
        "temperature": job["temperature"], "max_tokens": job["max_tokens"],
        "stream": false,
    });
    if job["json"] == true {
        b["response_format"] = json!({"type":"json_object"});
    }
    b
}

struct Reply {
    content: std::result::Result<String, String>,
    seconds: f64,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
}
async fn chat(client: &reqwest::Client, base: &str, model: &str, job: &Value) -> Reply {
    // A refused connection (a dropped tunnel) is retried a few times and is not counted in the
    // seconds; only the attempt that reached the server is timed.
    let mut tries = 0;
    loop {
        let started = Instant::now();
        let sent = client
            .post(format!("{base}/v1/chat/completions"))
            .json(&upstream(model, job))
            .send()
            .await;
        if let Err(e) = &sent {
            if e.is_connect() && tries < 12 {
                tries += 1;
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
        }
        return read_reply(sent, started).await;
    }
}
async fn read_reply(
    sent: std::result::Result<reqwest::Response, reqwest::Error>,
    started: Instant,
) -> Reply {
    let outcome: std::result::Result<Value, String> = match sent {
        Err(e) => Err(format!("send: {e}")),
        Ok(r) if !r.status().is_success() => Err(format!("status {}", r.status())),
        Ok(r) => r.json().await.map_err(|e| format!("body: {e}")),
    };
    let seconds = started.elapsed().as_secs_f64();
    match outcome {
        Err(e) => Reply {
            content: Err(e),
            seconds,
            prompt_tokens: None,
            completion_tokens: None,
        },
        Ok(v) => Reply {
            content: v["choices"][0]["message"]["content"]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "no content".to_string()),
            seconds,
            prompt_tokens: v["usage"]["prompt_tokens"].as_u64(),
            completion_tokens: v["usage"]["completion_tokens"].as_u64(),
        },
    }
}

/// What Connect reports for a finished job: its text, or a failure.
fn job_state(id: Uuid, reply: &Reply) -> Value {
    match &reply.content {
        Ok(text) => done(id, text),
        Err(_) => json!({"request_id":id,"status":"failed","error":"upstream_error"}),
    }
}

type Slot = Arc<Mutex<Option<Reply>>>;

#[tokio::test]
#[ignore = "needs BAKEOFF_BASE and BAKEOFF_MODEL: a model server to compare"]
async fn model_bakeoff() {
    let base = std::env::var("BAKEOFF_BASE").expect("BAKEOFF_BASE");
    let model = std::env::var("BAKEOFF_MODEL").expect("BAKEOFF_MODEL");
    let out_path = std::env::var("BAKEOFF_OUT").ok();
    let only: Option<Vec<String>> = std::env::var("BAKEOFF_ONLY")
        .ok()
        .map(|v| v.split(',').map(str::to_string).collect());
    let notes: Vec<Value> = serde_json::from_str(NOTES).unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(240))
        .build()
        .unwrap();

    // One practice with the real ICD-10-CM list and HCPCS list in force on the service date,
    // and the synthetic procedure list.
    let db = pool_at(None).await;
    let owner = actor(Uuid::new_v4(), Role::Owner);
    user(&db, &owner, "owner").await;
    let tenant = owner.tenant_id;
    let wanted: Vec<(&str, &[u8])> = crate::builtin_catalogs::BUILTIN
        .iter()
        .filter(|(n, _)| ["icd-10-cm-FY2027.json.gz", "hcpcs-2026-10.json.gz"].contains(n))
        .copied()
        .collect();
    assert_eq!(wanted.len(), 2);
    crate::builtin_catalogs::install_missing(&db, &wanted)
        .await
        .unwrap();
    for (code, display) in PRACTICE_LIST {
        sqlx::query("INSERT INTO practice_codes(tenant_id,id,system,code,display,enabled,price_cents,default_units,modifiers,version,created_by,updated_by) VALUES($1,$2,'CPT',$3,$4,true,5000,1,'',1,$5,$5)")
            .bind(tenant).bind(Uuid::new_v4()).bind(code).bind(display).bind(owner.sub).execute(&db).await.unwrap();
    }

    // Warm the model once, untimed, with the real first prompt on the first note.
    let first = &notes[0];
    let warm_sections = note_text(&Some(first["sections"].clone()));
    let warm = json!({"messages":[{"role":"system","content":EXTRACT_PROMPT},{"role":"user","content":user_message(&warm_sections)}],"max_tokens":900,"temperature":0.1,"json":true});
    let w = chat(&client, &base, &model, &warm).await;
    eprintln!(
        "warm-up {} in {:.1}s",
        if w.content.is_ok() { "ok" } else { "failed" },
        w.seconds
    );

    for (index, note) in notes.iter().enumerate() {
        let id = note["id"].as_str().unwrap();
        if only.as_ref().is_some_and(|o| !o.iter().any(|x| x == id)) {
            continue;
        }
        let (patient, appointment, visit) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        sqlx::query("INSERT INTO patients(tenant_id,id,mrn,given_name,family_name,birth_date) VALUES($1,$2,$3,'Test','Patient','1980-01-01')").bind(tenant).bind(patient).bind(format!("SYN-BAKE-{index}")).execute(&db).await.unwrap();
        let starts = chrono::DateTime::parse_from_rfc3339("2026-10-25T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            + chrono::Duration::minutes(30 * index as i64);
        sqlx::query("INSERT INTO appointments(tenant_id,id,patient_id,clinician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5,$6,'checked_in')").bind(tenant).bind(appointment).bind(patient).bind(owner.sub).bind(starts).bind(starts + chrono::Duration::minutes(30)).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO visits(tenant_id,id,patient_id,appointment_id,clinician_id,note) VALUES($1,$2,$3,$4,$5,$6)").bind(tenant).bind(visit).bind(patient).bind(appointment).bind(owner.sub).bind(note["sections"].clone()).execute(&db).await.unwrap();

        let request_id = Uuid::new_v4();
        let mut line = json!({"note":id,"model":model,"status":null,"error":null});
        let started = Instant::now();

        // Step 1: the real extract prompt, built and queued by the real code.
        let extract: Slot = Arc::default();
        let slot = extract.clone();
        let (c, b, m) = (client.clone(), base.clone(), model.clone());
        let queued = request(
            &db,
            &owner,
            visit,
            request_id,
            None,
            move |body| async move {
                *slot.lock().unwrap() = Some(chat(&c, &b, &m, &body).await);
                Ok(json!({"request_id":request_id,"status":"queued","position":0}))
            },
        )
        .await;
        if let Err(e) = queued {
            line["status"] = json!("request_refused");
            line["error"] = json!(format!("{e:?}"));
            emit(&line, &out_path);
            continue;
        }
        let extract = extract.lock().unwrap().take().expect("extract call ran");
        line["extract_s"] = json!((extract.seconds * 10.0).round() / 10.0);
        line["extract_tokens"] = json!([extract.prompt_tokens, extract.completion_tokens]);
        line["extract_raw"] = json!(extract.content.clone().unwrap_or_default());
        if let Err(e) = &extract.content {
            line["extract_error"] = json!(e);
        }

        // Lookup: the real extracted(), run by the real read(); the choose job is captured.
        let choose: Slot = Arc::default();
        let slot = choose.clone();
        let (c, b, m) = (client.clone(), base.clone(), model.clone());
        let state = job_state(request_id, &extract);
        let first = read(
            &db,
            &owner,
            visit,
            move |_| async move { Ok(state) },
            move |body| async move {
                let id = body["request_id"].clone();
                *slot.lock().unwrap() = Some(chat(&c, &b, &m, &body).await);
                Ok(json!({"request_id":id,"status":"queued","position":0}))
            },
        )
        .await
        .unwrap();
        let (problems, services): (Option<Value>, Option<Value>) = sqlx::query_as("SELECT problems,services FROM diagnosis_suggestion_requests WHERE tenant_id=$1 AND id=$2").bind(tenant).bind(request_id).fetch_one(&db).await.unwrap();
        let names = |v: &Option<Value>, key: &str| -> Vec<Value> {
            v.as_ref()
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|p| p[key].clone()).collect())
                .unwrap_or_default()
        };
        line["problems"] = json!(names(&problems, "problem"));
        line["problem_candidates"] = json!(problems
            .as_ref()
            .and_then(Value::as_array)
            .map(|a| a
                .iter()
                .map(|p| p["candidates"]
                    .as_array()
                    .map(|c| c.iter().map(|x| x["code"].clone()).collect::<Vec<_>>())
                    .unwrap_or_default())
                .collect::<Vec<_>>())
            .unwrap_or_default());
        line["services"] = json!(services
            .as_ref()
            .and_then(Value::as_array)
            .map(|a| a
                .iter()
                .map(|s| json!({"service":s["service"],"evidence":s["evidence"],"quantity":s["quantity"],"unit":s["quantity_unit"],"level":s["level"],"candidates":s["candidates"].as_array().map(|c| c.iter().map(|x| x["code"].clone()).collect::<Vec<_>>())}))
                .collect::<Vec<_>>())
            .unwrap_or_default());

        let mut last = first;
        let taken = choose.lock().unwrap().take();
        if let Some(reply) = taken {
            line["choose_s"] = json!((reply.seconds * 10.0).round() / 10.0);
            line["choose_tokens"] = json!([reply.prompt_tokens, reply.completion_tokens]);
            line["choose_raw"] = json!(reply.content.clone().unwrap_or_default());
            if let Err(e) = &reply.content {
                line["choose_error"] = json!(e);
            }
            let state = job_state(choose_job_id(request_id), &reply);
            last = read(
                &db,
                &owner,
                visit,
                move |_| async move { Ok(state) },
                |_| async move { Err(Error::Unavailable("no third job")) },
            )
            .await
            .unwrap();
        }
        line["total_s"] = json!((started.elapsed().as_secs_f64() * 10.0).round() / 10.0);
        line["status"] = last["status"].clone();
        line["error"] = last["error"].clone();
        let codes = |key: &str, field: &str| -> Vec<Value> {
            last[key]
                .as_array()
                .map(|a| a.iter().map(|x| x[field].clone()).collect())
                .unwrap_or_default()
        };
        line["suggested"] = json!(codes("suggestions", "code"));
        line["unmatched"] = json!(codes("unmatched", "problem"));
        line["dropped"] = last["dropped"].clone();
        line["procedures"] = json!(codes("procedures", "code"));
        line["procedures_unmatched"] = json!(codes("procedures_unmatched", "service"));
        emit(&line, &out_path);
    }
}

fn emit(line: &Value, path: &Option<String>) {
    println!("BAKEOFF {line}");
    if let Some(path) = path {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(f, "{line}").unwrap();
    }
}
