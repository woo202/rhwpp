//! rhwpp — rhwp 기반 Windows용 HWP/HWPX 워드프로세서의 네이티브 셸.
//!
//! 문서 편집기 자체는 업스트림 rhwp-studio(WASM)가 WebView2 안에서 동작한다. 이 크레이트는
//! 창 관리, 네이티브 파일 대화상자와 입출력, 파일 연결/단일 인스턴스, 창 상태 보존을 맡는다.

mod access;
mod files;
mod state;
mod windows;

use tauri::{DragDropEvent, Emitter, Manager, WindowEvent};
use tauri_plugin_window_state::StateFlags;

use crate::state::AppState;

pub fn run() {
    tauri::Builder::default()
        // 단일 인스턴스는 가장 먼저 등록해야 한다. 두 번째 실행은 기존 프로세스에 새 창을 연다.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            windows::handle_second_instance(app, argv, cwd);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                // 첫 창의 위치·크기만 기억한다. 나중 창은 문서 탭처럼 기준 창에 겹쳐 열린다.
                .with_filter(|label| label == "main")
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(AppState::new(&data_dir));
            let cwd = std::env::current_dir().unwrap_or_default();
            let paths = state::document_args(std::env::args_os().skip(1), &cwd);
            windows::create_document_window(app.handle(), paths, None)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // 끌어다 놓은 파일은 이번 실행 동안 읽기를 허용한다.
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                let state = window.state::<AppState>();
                let mut access = state.access.lock().unwrap();
                for path in paths {
                    access.grant(path);
                }
            }
            WindowEvent::Destroyed if windows::is_document_window(window.label()) => {
                let app = window.app_handle();
                app.state::<AppState>()
                    .window_documents
                    .lock()
                    .unwrap()
                    .remove(window.label());
                let _ = app.emit(windows::WINDOWS_CHANGED_EVENT, ());
                // 마지막 문서 창이 닫히면 남은 팝업(인쇄 미리보기)도 닫아 프로세스를 끝낸다.
                let any_document_left = app
                    .webview_windows()
                    .keys()
                    .any(|label| label != window.label() && windows::is_document_window(label));
                if !any_document_left {
                    for (label, popup) in app.webview_windows() {
                        if label.starts_with("popup-") {
                            let _ = popup.destroy();
                        }
                    }
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            files::dialog_open,
            files::dialog_save,
            files::read_file,
            files::write_file,
            files::file_stat,
            files::reveal_in_folder,
            files::open_external,
            files::app_data_dir,
            windows::take_launch_files,
            windows::open_window,
            windows::request_quit,
            windows::list_documents,
            windows::focus_window,
            windows::request_close_window,
            windows::set_window_document,
            windows::focus_window_for_document,
            windows::destroy_window,
        ])
        .run(tauri::generate_context!())
        .expect("rhwpp 실행 중 오류가 발생했습니다");
}
