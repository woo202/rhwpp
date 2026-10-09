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

const DEFAULT_WIDTH: f64 = 1280.0;
const DEFAULT_HEIGHT: f64 = 860.0;
const CASCADE_OFFSET: i32 = 32;

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
pub fn create_document_window<R: Runtime>(
    app: &AppHandle<R>,
    paths: Vec<PathBuf>,
) -> tauri::Result<WebviewWindow<R>> {
    let state = app.state::<AppState>();
    let label = state.next_window_label();
    state.queue_launch_files(&label, paths);

    let cascade_from = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.webview_windows().values().next().cloned());

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

    if let Some(prev) = cascade_from {
        if let (Ok(pos), Ok(false)) = (prev.outer_position(), prev.is_maximized()) {
            let scale = prev.scale_factor().unwrap_or(1.0);
            let pos = pos.to_logical::<f64>(scale);
            builder = builder.position(
                pos.x + f64::from(CASCADE_OFFSET),
                pos.y + f64::from(CASCADE_OFFSET),
            );
        } else {
            builder = builder.center();
        }
    } else {
        builder = builder.center();
    }

    builder.build()
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
pub fn open_window(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> Result<String, String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    {
        let access = state.access.lock().unwrap();
        if let Some(denied) = paths.iter().find(|p| !access.is_allowed(p)) {
            return Err(format!("허용되지 않은 경로입니다: {}", denied.display()));
        }
    }
    let window = create_document_window(&app, paths).map_err(|e| e.to_string())?;
    Ok(window.label().to_string())
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
    match create_document_window(app, paths) {
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
    fn classifies_app_urls() {
        assert!(is_app_url(&"http://tauri.localhost/index.html".parse().unwrap()));
        assert!(is_app_url(&"tauri://localhost/print.html".parse().unwrap()));
        assert!(is_app_url(&"about:blank".parse().unwrap()));
        assert!(!is_app_url(&"https://example.com/".parse().unwrap()));
        assert!(!is_app_url(&"file:///C:/Windows/win.ini".parse().unwrap()));
    }
}
