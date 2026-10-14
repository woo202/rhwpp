// 배포 빌드에서 콘솔 창을 띄우지 않는다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rhwpp_lib::run();
}
