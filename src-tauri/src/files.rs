//! 네이티브 파일 대화상자와 문서 읽기/쓰기 명령.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

/// 쓰기 요청에서 대상 경로를 담는 헤더(퍼센트 인코딩).
const PATH_HEADER: &str = "x-rhwpp-path";

#[derive(Debug, Clone, Deserialize)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PickedFile {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
    pub readonly: bool,
}

impl PickedFile {
    pub fn from_path(path: &Path) -> Self {
        Self {
            path: path.to_string_lossy().into_owned(),
            name: file_name(path),
        }
    }
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn stat(path: &Path) -> Result<FileStat, String> {
    let meta = fs::metadata(path).map_err(|e| io_message(path, &e))?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStat {
        path: path.to_string_lossy().into_owned(),
        name: file_name(path),
        size: meta.len(),
        modified_ms,
        readonly: meta.permissions().readonly(),
    })
}

fn io_message(path: &Path, error: &std::io::Error) -> String {
    use std::io::ErrorKind;
    let reason = match error.kind() {
        ErrorKind::NotFound => "파일을 찾을 수 없습니다".to_string(),
        ErrorKind::PermissionDenied => "접근 권한이 없거나 다른 프로그램이 파일을 사용 중입니다".to_string(),
        _ => error.to_string(),
    };
    format!("{}\n({})", reason, path.display())
}

fn apply_filters<R: tauri::Runtime>(
    mut builder: tauri_plugin_dialog::FileDialogBuilder<R>,
    filters: &[DialogFilter],
) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    for filter in filters {
        let extensions: Vec<&str> = filter
            .extensions
            .iter()
            .map(|ext| ext.trim_start_matches('.'))
            .filter(|ext| !ext.is_empty())
            .collect();
        if !extensions.is_empty() {
            builder = builder.add_filter(filter.name.clone(), &extensions);
        }
    }
    builder
}

fn default_directory(state: &AppState) -> Option<PathBuf> {
    state.last_directory.lock().unwrap().clone().or_else(|| {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(|home| PathBuf::from(home).join("Documents"))
            .filter(|dir| dir.is_dir())
    })
}

fn remember_directory(state: &AppState, path: &Path) {
    if let Some(parent) = path.parent() {
        *state.last_directory.lock().unwrap() = Some(parent.to_path_buf());
    }
}

/// 열기 대화상자. 취소하면 빈 배열.
#[tauri::command]
pub async fn dialog_open(
    window: WebviewWindow,
    state: State<'_, AppState>,
    filters: Vec<DialogFilter>,
    multiple: bool,
    title: Option<String>,
) -> Result<Vec<PickedFile>, String> {
    let mut builder = apply_filters(window.dialog().file(), &filters).set_parent(&window);
    if let Some(title) = title {
        builder = builder.set_title(title);
    }
    if let Some(dir) = default_directory(&state) {
        builder = builder.set_directory(dir);
    }
    // 대화상자가 떠 있는 동안 비동기 작업 스레드를 붙잡지 않도록 콜백 + 채널로 기다린다.
    let (tx, rx) = tokio::sync::oneshot::channel();
    if multiple {
        builder.pick_files(move |files| {
            let _ = tx.send(files.unwrap_or_default());
        });
    } else {
        builder.pick_file(move |file| {
            let _ = tx.send(file.into_iter().collect());
        });
    }
    let picked: Vec<tauri_plugin_dialog::FilePath> = rx.await.unwrap_or_default();
    let mut result = Vec::new();
    for file in picked {
        let path = file.into_path().map_err(|e| e.to_string())?;
        state.access.lock().unwrap().grant(&path);
        remember_directory(&state, &path);
        result.push(PickedFile::from_path(&path));
    }
    Ok(result)
}

/// 저장 대화상자. 취소하면 null.
#[tauri::command]
pub async fn dialog_save(
    window: WebviewWindow,
    state: State<'_, AppState>,
    filters: Vec<DialogFilter>,
    suggested_name: Option<String>,
    title: Option<String>,
) -> Result<Option<PickedFile>, String> {
    let mut builder = apply_filters(window.dialog().file(), &filters)
        .set_parent(&window)
        .set_can_create_directories(true);
    if let Some(title) = title {
        builder = builder.set_title(title);
    }
    if let Some(name) = suggested_name.filter(|name| !name.trim().is_empty()) {
        builder = builder.set_file_name(name);
    }
    if let Some(dir) = default_directory(&state) {
        builder = builder.set_directory(dir);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    builder.save_file(move |file| {
        let _ = tx.send(file);
    });
    let Some(file) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    let mut path = file.into_path().map_err(|e| e.to_string())?;
    // 사용자가 확장자를 지웠으면 첫 필터의 확장자를 붙인다.
    if path.extension().is_none() {
        if let Some(ext) = filters.first().and_then(|f| f.extensions.first()) {
            path.set_extension(ext.trim_start_matches('.'));
        }
    }
    state.access.lock().unwrap().grant(&path);
    remember_directory(&state, &path);
    Ok(Some(PickedFile::from_path(&path)))
}

/// 끌어다 놓기 직후에는 Rust 쪽 허용 처리와 JS 요청이 경합할 수 있어 잠깐 기다린다.
async fn wait_for_access(state: &AppState, path: &Path) -> bool {
    for _ in 0..10 {
        if state.access.lock().unwrap().is_allowed(path) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    false
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
    if !wait_for_access(&state, &path).await {
        return Err(format!("허용되지 않은 경로입니다: {}", path.display()));
    }
    let bytes = fs::read(&path).map_err(|e| io_message(&path, &e))?;
    state.access.lock().unwrap().remember(&path);
    remember_directory(&state, &path);
    Ok(Response::new(bytes))
}

/// 원자적 저장: 같은 폴더의 임시 파일에 쓴 뒤 교체한다. 교체가 막히면(다른 프로그램이
/// 파일을 열고 있는 등) 직접 덮어쓰기로 물러난다.
fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let tmp = dir.join(format!(
        ".~{}.{}.rhwpp-tmp",
        file_name(path),
        std::process::id()
    ));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        let mut file = fs::File::create(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    Ok(())
}

#[tauri::command]
pub async fn write_file(state: State<'_, AppState>, request: Request<'_>) -> Result<FileStat, String> {
    let header = request
        .headers()
        .get(PATH_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or("저장 경로가 없습니다")?;
    let path = PathBuf::from(
        percent_decode_str(header)
            .decode_utf8()
            .map_err(|e| e.to_string())?
            .into_owned(),
    );
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("저장할 데이터 형식이 올바르지 않습니다".into());
    };
    if !state.access.lock().unwrap().is_allowed(&path) {
        return Err(format!("허용되지 않은 경로입니다: {}", path.display()));
    }
    write_atomically(&path, bytes).map_err(|e| io_message(&path, &e))?;
    state.access.lock().unwrap().remember(&path);
    remember_directory(&state, &path);
    stat(&path)
}

#[tauri::command]
pub fn file_stat(state: State<'_, AppState>, path: String) -> Result<FileStat, String> {
    let path = PathBuf::from(path);
    if !state.access.lock().unwrap().is_allowed(&path) {
        return Err(format!("허용되지 않은 경로입니다: {}", path.display()));
    }
    stat(&path)
}

/// 탐색기에서 파일 위치 열기.
#[tauri::command]
pub fn reveal_in_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !state.access.lock().unwrap().is_allowed(&path) {
        return Err(format!("허용되지 않은 경로입니다: {}", path.display()));
    }
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

/// 외부 링크(http/https/mailto)를 기본 브라우저로 연다.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let allowed = ["http://", "https://", "mailto:"];
    if !allowed.iter().any(|prefix| url.to_ascii_lowercase().starts_with(prefix)) {
        return Err(format!("열 수 없는 주소입니다: {url}"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// 앱 데이터 폴더(자동 백업 위치 안내 등).
#[tauri::command]
pub fn app_data_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_existing_file() {
        let dir = std::env::temp_dir().join(format!("rhwpp-write-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("문서.hwp");
        fs::write(&path, b"old").unwrap();
        write_atomically(&path, b"new contents").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new contents");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".rhwpp-tmp"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
