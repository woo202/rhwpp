fn main() {
    // 앱 명령에도 권한을 요구한다. capabilities/default.json 에 나열된 창만 호출할 수 있다
    // (인쇄 미리보기 같은 팝업 창은 IPC 를 쓰지 못한다).
    let commands = &[
        "dialog_open",
        "dialog_save",
        "read_file",
        "write_file",
        "file_stat",
        "reveal_in_folder",
        "open_external",
        "app_data_dir",
        "take_launch_files",
        "open_window",
        "request_quit",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("tauri-build 실패");
}
