// SPDX-License-Identifier: AGPL-3.0-only
//! Enrolled Office Ally / Availity mailboxes via OpenSSH SFTP with strict host-key checking.
use crate::{
    clearinghouse::Submission,
    delivery::{Adapter, Route},
    error::{Error, Result},
    retrieval::{Observation, Page},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{path::PathBuf, process::Stdio};
use tokio::io::AsyncReadExt;
use uuid::Uuid;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub username_env: String,
    pub private_key_env: String,
    pub known_hosts_env: String,
    pub inbox_dir: String,
}
fn safe_path(s: &str) -> bool {
    s.starts_with('/')
        && s.len() <= 250
        && !s.contains("..")
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
}
fn safe_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 150
        && !s.starts_with('.')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
pub(crate) fn validate(r: &Route) -> Result<()> {
    if !matches!(r.adapter, Adapter::OfficeAllySftp | Adapter::AvailitySftp) {
        return Err(Error::Invalid("invalid SFTP adapter"));
    }
    let s = r
        .sftp
        .as_ref()
        .ok_or(Error::Invalid("SFTP settings required"))?;
    let u = url::Url::parse(&r.endpoint).map_err(|_| Error::Invalid("invalid SFTP destination"))?;
    if u.scheme() != "sftp"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || !safe_path(u.path())
        || !safe_path(&s.inbox_dir)
        || r.credential_env.is_some()
        || r.loopback_test
    {
        return Err(Error::Invalid("SFTP requires an enrolled host, safe absolute directories and file-based SSH credentials"));
    }
    for k in [&s.username_env, &s.private_key_env, &s.known_hosts_env] {
        if !k.starts_with("ENGINE_CLEARINGHOUSE_SFTP_")
            || !k
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        {
            return Err(Error::Invalid("invalid SFTP credential reference"));
        }
    }
    if let Some(v) = &r.retrieval {
        v.validate(r)?;
    }
    Ok(())
}
pub(crate) fn credentials_available(r: &Route) -> bool {
    r.sftp.as_ref().is_some_and(|s| {
        [&s.username_env, &s.private_key_env, &s.known_hosts_env]
            .iter()
            .all(|k| std::env::var(k).is_ok_and(|v| !v.trim().is_empty()))
    })
}
struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Result<Self> {
        let p = std::env::temp_dir().join(format!("suncharts-sftp-{}", Uuid::new_v4()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&p)
                .map_err(|_| Error::Invalid("private SFTP workspace unavailable"))?;
        }
        #[cfg(not(unix))]
        {
            return Err(Error::Invalid(
                "SFTP adapter requires a Unix OpenSSH installation",
            ));
        }
        Ok(Self(p))
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn env(k: &str) -> Result<String> {
    std::env::var(k)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or(Error::Invalid("SFTP credential unavailable"))
}
async fn run(r: &Route, work: &Workspace, batch: &str) -> Result<String> {
    validate(r)?;
    let s = r.sftp.as_ref().unwrap();
    let u = url::Url::parse(&r.endpoint).unwrap();
    let username = env(&s.username_env)?;
    if !safe_name(&username) {
        return Err(Error::Invalid("invalid SFTP username"));
    }
    let identity = env(&s.private_key_env)?;
    let known_hosts = env(&s.known_hosts_env)?;
    for p in [&identity, &known_hosts] {
        let m = std::fs::symlink_metadata(p)
            .map_err(|_| Error::Invalid("SFTP credential file unavailable"))?;
        if !m.is_file() || !std::path::Path::new(p).is_absolute() {
            return Err(Error::Invalid(
                "SFTP requires absolute regular credential files",
            ));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(&known_hosts)
            .map_err(|_| Error::Invalid("SFTP host-key file unavailable"))?
            .permissions()
            .mode()
            & 0o022
            != 0
        {
            return Err(Error::Invalid(
                "SFTP host-key file must not be writable by other users",
            ));
        }
        if std::fs::metadata(&identity)
            .map_err(|_| Error::Invalid("SFTP identity unavailable"))?
            .permissions()
            .mode()
            & 0o077
            != 0
        {
            return Err(Error::Invalid(
                "SFTP private key permissions must be private",
            ));
        }
    }
    let file = work.0.join("commands");
    tokio::fs::write(&file, batch)
        .await
        .map_err(|_| Error::Invalid("SFTP command file unavailable"))?;
    let mut command = tokio::process::Command::new("/usr/bin/sftp");
    command
        .args([
            "-q",
            "-F",
            "/dev/null",
            "-oBatchMode=yes",
            "-oStrictHostKeyChecking=yes",
            "-oIdentitiesOnly=yes",
            "-oIdentityAgent=none",
            "-oPasswordAuthentication=no",
            "-oKbdInteractiveAuthentication=no",
            "-oGlobalKnownHostsFile=/dev/null",
            "-oConnectTimeout=5",
            "-oConnectionAttempts=1",
            "-oLogLevel=ERROR",
        ])
        .arg(format!("-oUserKnownHostsFile={known_hosts}"))
        .arg("-i")
        .arg(identity)
        .arg("-P")
        .arg(u.port().unwrap_or(22).to_string())
        .arg("-b")
        .arg(&file)
        .arg(format!("{username}@{}", u.host_str().unwrap()))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| Error::Invalid("OpenSSH sftp unavailable"))?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let mut bytes = vec![];
        child
            .stdout
            .take()
            .unwrap()
            .take(262145)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| Error::Invalid("SFTP read failed"))?;
        if bytes.len() > 262144 {
            return Err(Error::Invalid("SFTP listing too large"));
        }
        let status = child
            .wait()
            .await
            .map_err(|_| Error::Invalid("SFTP process failed"))?;
        if !status.success() {
            return Err(Error::Invalid(
                "SFTP operation failed; verify host key, enrollment and receipt",
            ));
        }
        String::from_utf8(bytes).map_err(|_| Error::Invalid("SFTP listing must be text"))
    })
    .await
    .map_err(|_| Error::Invalid("SFTP operation timed out; reconcile uncertain upload"))?;
    result
}
pub(crate) async fn upload(r: &Route, out: &Submission) -> Result<String> {
    let work = Workspace::new()?;
    let local = work.0.join("artifact.x12");
    tokio::fs::write(&local, &out.payload)
        .await
        .map_err(|_| Error::Invalid("private SFTP artifact unavailable"))?;
    let directory = url::Url::parse(&r.endpoint)
        .unwrap()
        .path()
        .trim_end_matches('/')
        .to_string();
    let name = format!("837P_{}.x12", out.id);
    let temp = format!("{directory}/.{name}.uploading");
    let dest = format!("{directory}/{name}");
    run(
        r,
        &work,
        &format!("put {} {temp}\nrename {temp} {dest}\n", local.display()),
    )
    .await?;
    Ok(name)
}
pub(crate) async fn page(r: &Route) -> Result<Page> {
    let work = Workspace::new()?;
    let dir = r.sftp.as_ref().unwrap().inbox_dir.trim_end_matches('/');
    let output = run(r, &work, &format!("ls -1 {dir}/\n")).await?;
    let mut items = vec![];
    for line in output
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with("sftp>"))
    {
        let name = line.strip_prefix(&format!("{dir}/")).unwrap_or(line);
        if name == "." || name == ".." {
            continue;
        }
        if !safe_name(name) {
            return Err(Error::Invalid(
                "SFTP inbox contains unsupported filenames; no files removed",
            ));
        }
        if items.len() >= 1000 {
            return Err(Error::Invalid("SFTP inbox exceeds 1000-file preview limit; archive previously retrieved files with provider"));
        }
        let format = match name
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "277" | "277ca" => "x12_277ca",
            "999" => "x12_999",
            "ta1" => "x12_ta1",
            "835" => "x12_835",
            _ => "x12_unknown",
        };
        items.push(Observation{remote_id:name.into(),format:format.into(),metadata:json!({"source":"enrolled_sftp_inbox","filename":name,"mode_binding":r.usage}),status:"pending".into(),inline:None});
    }
    Ok(Page { items, next: None })
}
pub(crate) async fn input(r: &Route, name: &str) -> Result<String> {
    if !safe_name(name) {
        return Err(Error::Invalid("unsafe SFTP report name"));
    }
    let work = Workspace::new()?;
    let local = work.0.join("report");
    let dir = r.sftp.as_ref().unwrap().inbox_dir.trim_end_matches('/');
    let stat = run(r, &work, &format!("ls -ln {dir}/{name}\n")).await?;
    let size = stat
        .lines()
        .filter(|s| s.starts_with('-'))
        .find_map(|line| {
            line.split_whitespace()
                .nth(4)
                .and_then(|n| n.parse::<u64>().ok())
        })
        .ok_or(Error::Invalid("SFTP report size unavailable"))?;
    if size > 48000 {
        return Err(Error::Invalid("SFTP report exceeds supported 48 KB"));
    }
    run(r, &work, &format!("get {dir}/{name} {}\n", local.display())).await?;
    let size = tokio::fs::metadata(&local)
        .await
        .map_err(|_| Error::Invalid("SFTP report missing"))?
        .len();
    if size > 48000 {
        return Err(Error::Invalid("SFTP report exceeds supported 48 KB"));
    }
    let raw = tokio::fs::read_to_string(&local)
        .await
        .map_err(|_| Error::Invalid("SFTP report not text"))?;
    if !raw.is_ascii() || raw.is_empty() {
        return Err(Error::Invalid("SFTP report must be ASCII"));
    }
    Ok(raw)
}
