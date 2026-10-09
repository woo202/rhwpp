//! 문서 창 생성과 창 관련 명령.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

use crate::files::PickedFile;
use crate::state::AppState;

pub const CLOSE_REQUEST_EVENT: &str = "rhwpp://close-request";
/// 문서 창이 생기거나 닫히거나 제목이 바뀌면 모든 창에 알린다(문서 탭 갱신).
pub const WINDOWS_CHANGED_EVENT: &str = "rhwpp://windows-changed";

const DEFAULT_WIDTH: f64 = 1280.0;
const DEFAULT_HEIGHT: f64 = 860.0;

static POPUP_COUNTER: AtomicU32 = AtomicU32::new(0);

/// 앱 자체 페이지인가 (배포: tauri.localhost / tauri://, 개발: Vite 서버).
pub fn is_app_url(url: &Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    match (url.scheme(), url.host_str()) {
        ("tauri", _) => true,
        ("http" | "https", Some("tauri.localhost")) => true,
        ("http", Some("127.0.0.1" | "localhost")) => cfg!(debug_assertions) && url.port() == Some(1420),
        _ => false,
    }
}

fn is_external_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

fn open_externally<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if is_external_url(url) {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// 문서 창을 만든다. `paths` 는 창이 준비되면 열 문서들이다.
///
/// 한글의 문서 탭처럼 보이도록 새 창은 기준 창(`like`, 없으면 지금 활성 창)과 같은 자리·크기로
/// 겹쳐 연다. 하단 문서 탭으로 창 사이를 오간다.
pub fn create_document_window<R: Runtime>(
    app: &AppHandle<R>,
    paths: Vec<PathBuf>,
    like: Option<&WebviewWindow<R>>,
) -> tauri::Result<WebviewWindow<R>> {
    let state = app.state::<AppState>();
    let label = state.next_window_label();
    state.queue_launch_files(&label, paths);

    let reference = like.cloned().or_else(|| {
        let windows = app.webview_windows();
        windows
            .values()
            .find(|w| is_document_window(w.label()) && w.is_focused().unwrap_or(false))
            .cloned()
            .or_else(|| windows.values().find(|w| is_document_window(w.label())).cloned())
    });

    let app_for_popup = app.clone();
    let app_for_nav = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("rhwpp")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(820.0, 560.0)
        // 한글처럼 제목 표시줄을 직접 그린다(빠른 실행 도구, 문서 제목, 창 단추).
        .decorations(false)
        .shadow(true)
        .resizable(true)
        .background_color(tauri::window::Color(240, 240, 240, 255))
        .zoom_hotkeys_enabled(false)
        // 붙이기(클립보드 읽기)와 설치된 글꼴 목록(글꼴 상자)은 묻지 않고 허용한다.
        // 카메라·위치 등 문서 편집과 무관한 권한은 거절한다.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::ClipboardRead | PermissionKind::LocalFonts | PermissionKind::FileSystemAccess => {
                PermissionResponse::Allow
            }
            _ => PermissionResponse::Deny,
        })
        .on_navigation(move |url| {
            if is_app_url(url) {
                true
            } else {
                open_externally(&app_for_nav, url);
                false
            }
        })
        .on_new_window(move |url, features| {
            if !is_app_url(&url) {
                open_externally(&app_for_popup, &url);
                return NewWindowResponse::Deny;
            }
            // 인쇄 미리보기(print.html) 같은 같은 출처 팝업. window.open 이 돌려준 창을
            // 스튜디오가 직접 그려 넣으므로 opener 관계를 유지한 Tauri 창으로 만든다.
            let n = POPUP_COUNTER.fetch_add(1, Ordering::SeqCst);
            let popup = WebviewWindowBuilder::new(
                &app_for_popup,
                format!("popup-{n}"),
                WebviewUrl::External("about:blank".parse().expect("about:blank")),
            )
            .window_features(features)
            .title("인쇄 미리보기 - rhwpp")
            .inner_size(1000.0, 820.0)
            .center()
            .on_document_title_changed(|window, title| {
                let _ = window.set_title(&title);
            })
            .build();
            match popup {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        });

    match reference.as_ref().and_then(|w| geometry_of(w)) {
        Some(geometry) => {
            builder = builder
                .position(geometry.x, geometry.y)
                .inner_size(geometry.width, geometry.height)
                .maximized(geometry.maximized);
        }
        None => builder = builder.center(),
    }

    let window = builder.build()?;
    let _ = app.emit(WINDOWS_CHANGED_EVENT, ());
    Ok(window)
}

struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    maximized: bool,
}

fn geometry_of<R: Runtime>(window: &WebviewWindow<R>) -> Option<Geometry> {
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(Geometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    })
}

/// `target` 을 `source` 와 같은 자리·크기로 옮긴다(탭 전환처럼 보이게).
fn match_geometry<R: Runtime>(source: &WebviewWindow<R>, target: &WebviewWindow<R>) {
    let Some(geometry) = geometry_of(source) else { return };
    if geometry.maximized {
        let _ = target.set_position(tauri::LogicalPosition::new(geometry.x, geometry.y));
        let _ = target.maximize();
    } else {
        if target.is_maximized().unwrap_or(false) {
            let _ = target.unmaximize();
        }
        let _ = target.set_position(tauri::LogicalPosition::new(geometry.x, geometry.y));
        let _ = target.set_size(tauri::LogicalSize::new(geometry.width, geometry.height));
    }
}

pub fn is_document_window(label: &str) -> bool {
    label == "main" || label.starts_with("doc-")
}

fn window_order(label: &str) -> u32 {
    label.strip_prefix("doc-").and_then(|n| n.parse().ok()).unwrap_or(0)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DocumentWindow {
    pub label: String,
    pub title: String,
    pub focused: bool,
}

/// 열린 문서 창 목록(문서 탭). 창을 연 순서대로.
#[tauri::command]
pub fn list_documents(app: AppHandle) -> Vec<DocumentWindow> {
    let mut windows: Vec<DocumentWindow> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| is_document_window(label))
        .map(|(label, window)| DocumentWindow {
            title: window.title().unwrap_or_default(),
            focused: window.is_focused().unwrap_or(false),
            label,
        })
        .collect();
    windows.sort_by_key(|w| window_order(&w.label));
    windows
}

/// 문서 탭을 눌렀을 때: 그 창을 앞으로 가져온다.
#[tauri::command]
pub fn focus_window(app: AppHandle, caller: WebviewWindow, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .filter(|_| is_document_window(&label))
        .ok_or_else(|| format!("창을 찾을 수 없습니다: {label}"))?;
    if window.is_minimized().unwrap_or(false) {
        window.unminimize().map_err(|e| e.to_string())?;
    }
    if caller.label() != window.label() {
        match_geometry(&caller, &window);
    }
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

/// 문서 탭의 × : 그 창에 닫기 요청(저장 확인은 그 창이 한다).
#[tauri::command]
pub fn request_close_window(app: AppHandle, label: String) -> Result<(), String> {
    if !is_document_window(&label) {
        return Err(format!("문서 창이 아닙니다: {label}"));
    }
    app.emit_to(label.as_str(), CLOSE_REQUEST_EVENT, ())
        .map_err(|e| e.to_string())
}

/// 이 창이 시작할 때 열어야 할 문서(실행 인자, 다른 창에서 넘긴 문서).
#[tauri::command]
pub fn take_launch_files(window: WebviewWindow, state: State<'_, AppState>) -> Vec<PickedFile> {
    state
        .take_launch_files(window.label())
        .iter()
        .map(|path| PickedFile::from_path(path))
        .collect()
}

/// 새 창. `paths` 가 있으면 그 문서들을 연다(이미 접근이 허용된 경로만).
#[tauri::command]
pub fn open_window(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<String, String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    {
        let access = state.access.lock().unwrap();
        if let Some(denied) = paths.iter().find(|p| !access.is_allowed(p)) {
            return Err(format!("허용되지 않은 경로입니다: {}", denied.display()));
        }
    }
    let created = create_document_window(&app, paths, Some(&window)).map_err(|e| e.to_string())?;
    Ok(created.label().to_string())
}

/// 프로그램 끝(Alt+X): 모든 문서 창에 닫기 요청을 보낸다. 각 창은 저장 확인 후 스스로 닫힌다.
#[tauri::command]
pub fn request_quit(app: AppHandle) {
    for window in app.webview_windows().values() {
        if window.label().starts_with("popup-") {
            let _ = window.destroy();
        } else {
            let _ = window.emit_to(window.label(), CLOSE_REQUEST_EVENT, ());
        }
    }
}

/// 다른 인스턴스로 실행됐을 때(탐색기에서 문서를 다시 연 경우 등).
pub fn handle_second_instance<R: Runtime>(app: &AppHandle<R>, argv: Vec<String>, cwd: String) {
    let paths = crate::state::document_args(argv.iter().skip(1), std::path::Path::new(&cwd));
    match create_document_window(app, paths, None) {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(error) => eprintln!("[rhwpp] 새 창을 만들지 못했습니다: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_document_windows() {
        assert!(is_document_window("main"));
        assert!(is_document_window("doc-3"));
        assert!(!is_document_window("popup-0"));
        let mut labels = vec!["doc-10", "main", "doc-2"];
        labels.sort_by_key(|l| window_order(l));
        assert_eq!(labels, vec!["main", "doc-2", "doc-10"]);
    }

    #[test]
    fn classifies_app_urls() {
        assert!(is_app_url(&"http://tauri.localhost/index.html".parse().unwrap()));
        assert!(is_app_url(&"tauri://localhost/print.html".parse().unwrap()));
        assert!(is_app_url(&"about:blank".parse().unwrap()));
        assert!(!is_app_url(&"https://example.com/".parse().unwrap()));
        assert!(!is_app_url(&"file:///C:/Windows/win.ini".parse().unwrap()));
    }
}
