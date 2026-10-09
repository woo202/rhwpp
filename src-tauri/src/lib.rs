//! rhwpp — rhwp 기반 Windows용 HWP/HWPX 워드프로세서의 네이티브 셸.
//!
//! 문서 편집기 자체는 업스트림 rhwp-studio(WASM)가 WebView2 안에서 동작한다. 이 크레이트는
//! 창 관리, 네이티브 파일 대화상자와 입출력, 파일 연결/단일 인스턴스, 창 상태 보존을 맡는다.

mod access;
mod files;
mod state;
mod windows;

use tauri::{DragDropEvent, Manager, WindowEvent};
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
                // 인쇄 미리보기 같은 임시 팝업은 위치를 기억하지 않는다.
                .with_filter(|label| !label.starts_with("popup-"))
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(AppState::new(&data_dir));
            let cwd = std::env::current_dir().unwrap_or_default();
            let paths = state::document_args(std::env::args_os().skip(1), &cwd);
            windows::create_document_window(app.handle(), paths)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 끌어다 놓은 파일은 이번 실행 동안 읽기를 허용한다.
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                let state = window.state::<AppState>();
                let mut access = state.access.lock().unwrap();
                for path in paths {
                    access.grant(path);
                }
            }
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
        ])
        .run(tauri::generate_context!())
        .expect("rhwpp 실행 중 오류가 발생했습니다");
}
