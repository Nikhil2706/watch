//! Offline bundles for the Windows app — the storage half of src/lib/offline.
//!
//! Mirrors what OfflinePlugin.java does on Android, against the same server
//! contract, so the web UI is identical on both. One bundle per title:
//!
//!   <app data>/offline/<itemId>/media.mp4
//!   <app data>/offline/<itemId>/poster.jpg
//!   <app data>/offline/<itemId>/subs/<n>-<lang>.vtt
//!   <app data>/offline/<itemId>/bundle.json
//!
//! Two things here are not obvious and are worth reading before changing:
//!
//! 1. EVERY COMMAND IS ASYNC. `cookies_for_url` is documented to deadlock on
//!    Windows when called from a synchronous command, and Windows is the only
//!    platform this app ships on, so a blocking command here would hang the
//!    whole app rather than fail.
//!
//! 2. Cookies have to be read from the webview at all because the session
//!    cookie is httpOnly — the page cannot hand it over even deliberately, and
//!    a plain request without it comes back as the login page, which would be
//!    saved as a perfectly valid and completely unplayable file.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Webview};

const MEDIA: &str = "media.mp4";
const POSTER: &str = "poster.jpg";
const BUNDLE: &str = "bundle.json";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subtitle {
    pub index: i64,
    pub label: String,
    pub language: Option<String>,
    pub recommended: bool,
    #[serde(default)]
    pub is_forced: bool,
    pub url: String,
    pub filename: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub item_id: String,
    pub title: String,
    pub year: Option<i64>,
    pub duration_seconds: Option<i64>,
    pub media: Media,
    pub poster: Option<String>,
    #[serde(default)]
    pub subtitles: Vec<Subtitle>,
}

/// Mirrors OfflineBundle in src/lib/offline/types.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub item_id: String,
    pub title: String,
    pub year: Option<i64>,
    pub duration_seconds: Option<i64>,
    pub state: String,
    pub progress: u8,
    pub bytes_done: Option<u64>,
    pub bytes_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub subtitles: Vec<Subtitle>,
}

// ------------------------------------------------------------------ paths

fn offline_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data directory: {e}"))?
        .join("offline");
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Item ids are hex in practice, but they arrive as server-provided strings
/// and are about to become filesystem paths. Anything outside a safe set
/// becomes an underscore, which also disposes of "..".
fn safe(component: &str) -> String {
    component
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn bundle_dir(app: &AppHandle, item_id: &str) -> Result<PathBuf, String> {
    Ok(offline_root(app)?.join(safe(item_id)))
}

// ------------------------------------------------------------- http bits

/// Resolves a site-relative manifest URL against the page the webview is on.
fn absolute(webview: &Webview, url: &str) -> String {
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.to_string();
    }
    match webview.url().ok().and_then(|base| base.join(url).ok()) {
        Some(joined) => joined.to_string(),
        None => url.to_string(),
    }
}

/// The Cookie header for a URL, taken from the webview's own jar.
async fn cookie_header(webview: &Webview, url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let cookies = webview.cookies_for_url(parsed).ok()?;
    if cookies.is_empty() {
        return None;
    }
    Some(
        cookies
            .iter()
            .map(|c| format!("{}={}", c.name(), c.value()))
            .collect::<Vec<_>>()
            .join("; "),
    )
}

async fn fetch_small(webview: &Webview, url: &str, target: &Path) -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut request = client.get(url);
    if let Some(cookie) = cookie_header(webview, url).await {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("{} returned {}", url, response.status()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    fs::write(target, &bytes).map_err(|e| e.to_string())
}

// -------------------------------------------------------------- commands

#[tauri::command]
pub async fn offline_start(
    app: AppHandle,
    webview: Webview,
    manifest: Manifest,
) -> Result<(), String> {
    let dir = bundle_dir(&app, &manifest.item_id)?;
    fs::create_dir_all(dir.join("subs")).map_err(|e| e.to_string())?;

    let mut record = Bundle {
        item_id: manifest.item_id.clone(),
        title: manifest.title.clone(),
        year: manifest.year,
        duration_seconds: manifest.duration_seconds,
        state: "downloading".into(),
        progress: 0,
        bytes_done: Some(0),
        bytes_total: None,
        error: None,
        subtitles: manifest.subtitles.clone(),
    };
    write_record(&dir, &record)?;

    // Subtitles and poster first, and deliberately so: they are tens of
    // kilobytes, and a bundle whose film is still arriving is far more useful
    // with its subtitle list already on disk than the other way round. A
    // subtitle that fails is a worse film, not a failed download.
    for track in &manifest.subtitles {
        let url = absolute(&webview, &track.url);
        let _ = fetch_small(&webview, &url, &dir.join("subs").join(safe(&track.filename))).await;
    }
    if let Some(poster) = &manifest.poster {
        let url = absolute(&webview, poster);
        let _ = fetch_small(&webview, &url, &dir.join(POSTER)).await;
    }

    let media_url = absolute(&webview, &manifest.media.url);
    match download_media(&webview, &media_url, &dir, &mut record).await {
        Ok(()) => {
            record.state = "ready".into();
            record.progress = 100;
            record.error = None;
        }
        Err(e) => {
            record.state = "failed".into();
            record.error = Some(e);
        }
    }
    write_record(&dir, &record)?;
    Ok(())
}

/// Streams the film to disk, resuming a partial file if one is there.
///
/// This is the half that makes the server's Range support worth having: a
/// dropped connection on a multi-gigabyte film should cost the remainder, not
/// the whole thing.
async fn download_media(
    webview: &Webview,
    url: &str,
    dir: &Path,
    record: &mut Bundle,
) -> Result<(), String> {
    let target = dir.join(MEDIA);
    let partial = dir.join("media.part");

    let already = fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);

    let client = reqwest::Client::new();
    let mut request = client.get(url);
    if let Some(cookie) = cookie_header(webview, url).await {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    if already > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={already}-"));
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    if !(status.is_success() || status == reqwest::StatusCode::PARTIAL_CONTENT) {
        return Err(format!("Server returned {status}"));
    }

    // 200 to a ranged request means the server ignored it and is sending the
    // whole file; anything already on disk is then not a prefix of what is
    // arriving, so start over rather than produce a corrupt file.
    let resuming = already > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut file = if resuming {
        fs::OpenOptions::new().append(true).open(&partial).map_err(|e| e.to_string())?
    } else {
        fs::File::create(&partial).map_err(|e| e.to_string())?
    };

    let mut written: u64 = if resuming { already } else { 0 };
    let total = response.content_length().map(|len| written + len);
    record.bytes_total = total;

    let mut stream = response.bytes_stream();
    let mut since_flush: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        written += chunk.len() as u64;
        since_flush += chunk.len() as u64;

        // Progress is persisted rather than held in memory so the UI can read
        // it from bundle.json without this task having to talk to it — and so
        // it survives the app being closed mid-download.
        if since_flush > 4 * 1024 * 1024 {
            since_flush = 0;
            record.bytes_done = Some(written);
            record.progress = match total {
                Some(t) if t > 0 => ((written * 100) / t).min(100) as u8,
                _ => 0,
            };
            let _ = write_record(dir, record);
        }
    }

    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    // Rename only once complete: a half-written media.mp4 would look ready.
    fs::rename(&partial, &target).map_err(|e| e.to_string())?;
    record.bytes_done = Some(written);
    record.bytes_total = Some(written);
    Ok(())
}

#[tauri::command]
pub async fn offline_list(app: AppHandle) -> Result<Vec<Bundle>, String> {
    let root = offline_root(&app)?;
    let mut out = Vec::new();
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        if let Some(bundle) = read_record(&entry.path()) {
            out.push(bundle);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn offline_remove(app: AppHandle, item_id: String) -> Result<(), String> {
    let dir = bundle_dir(&app, &item_id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn offline_local_url(
    app: AppHandle,
    item_id: String,
    file: String,
) -> Result<Option<String>, String> {
    let dir = bundle_dir(&app, &item_id)?;
    let target = match file.as_str() {
        "media" => dir.join(MEDIA),
        "poster" => dir.join(POSTER),
        other => dir.join("subs").join(safe(other)),
    };
    // The path, not a URL: the web layer runs it through convertFileSrc,
    // which is the only thing that knows this webview's asset scheme.
    Ok(if target.exists() { Some(target.to_string_lossy().to_string()) } else { None })
}

#[tauri::command]
pub async fn offline_read_text(
    app: AppHandle,
    item_id: String,
    file: String,
) -> Result<Option<String>, String> {
    let dir = bundle_dir(&app, &item_id)?;
    let target = dir.join("subs").join(safe(&file));
    Ok(fs::read_to_string(target).ok())
}

// ----------------------------------------------------------------- state

fn write_record(dir: &Path, record: &Bundle) -> Result<(), String> {
    let json = serde_json::to_string(record).map_err(|e| e.to_string())?;
    fs::write(dir.join(BUNDLE), json).map_err(|e| e.to_string())
}

fn read_record(dir: &Path) -> Option<Bundle> {
    let text = fs::read_to_string(dir.join(BUNDLE)).ok()?;
    let mut bundle: Bundle = serde_json::from_str(&text).ok()?;

    // The app can be closed mid-download, which leaves a record saying
    // "downloading" that nothing is advancing. Reconcile against what is
    // actually on disk so the UI offers a retry instead of a frozen bar.
    if bundle.state == "downloading" && dir.join(MEDIA).exists() {
        bundle.state = "ready".into();
        bundle.progress = 100;
    } else if bundle.state == "downloading" {
        bundle.state = "failed".into();
        bundle.error = Some("The download was interrupted.".into());
    }
    Some(bundle)
}
