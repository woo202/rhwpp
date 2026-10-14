//! 앱 전역 상태.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use crate::access::AccessList;

pub struct AppState {
    pub access: Mutex<AccessList>,
    /// 창 라벨 → 그 창이 시작할 때 열 문서 경로.
    pub launch_files: Mutex<HashMap<String, Vec<PathBuf>>>,
    /// 마지막으로 파일을 열거나 저장한 폴더(대화상자 시작 위치).
    pub last_directory: Mutex<Option<PathBuf>>,
    /// 창 라벨 → 그 창이 편집 중인 문서 경로(같은 문서를 두 창에서 열지 않기 위해).
    pub window_documents: Mutex<HashMap<String, PathBuf>>,
    window_counter: AtomicU32,
}

impl AppState {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            access: Mutex::new(AccessList::load(data_dir)),
            launch_files: Mutex::new(HashMap::new()),
            last_directory: Mutex::new(None),
            window_documents: Mutex::new(HashMap::new()),
            window_counter: AtomicU32::new(0),
        }
    }

    pub fn next_window_label(&self) -> String {
        let n = self.window_counter.fetch_add(1, Ordering::SeqCst);
        if n == 0 {
            "main".to_string()
        } else {
            format!("doc-{n}")
        }
    }

    pub fn queue_launch_files(&self, label: &str, paths: Vec<PathBuf>) {
        if paths.is_empty() {
            return;
        }
        let mut access = self.access.lock().unwrap();
        for path in &paths {
            access.grant(path);
        }
        drop(access);
        self.launch_files
            .lock()
            .unwrap()
            .entry(label.to_string())
            .or_default()
            .extend(paths);
    }

    /// 이 문서를 이미 편집 중인 창(자기 자신 제외).
    pub fn window_for_document(&self, path: &Path, except: Option<&str>) -> Option<String> {
        let target = crate::access::normalize(path);
        self.window_documents
            .lock()
            .unwrap()
            .iter()
            .find(|(label, doc)| Some(label.as_str()) != except && crate::access::normalize(doc) == target)
            .map(|(label, _)| label.clone())
    }

    pub fn take_launch_files(&self, label: &str) -> Vec<PathBuf> {
        self.launch_files.lock().unwrap().remove(label).unwrap_or_default()
    }
}

/// 실행 인자에서 문서 경로를 고른다. 옵션(-x, --x)은 건너뛰고 상대 경로는 cwd 기준으로 푼다.
pub fn document_args<I, S>(args: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    args.into_iter()
        .filter_map(|arg| {
            let arg = arg.as_ref();
            let text = arg.to_string_lossy();
            if text.starts_with('-') || text.is_empty() {
                return None;
            }
            let path = PathBuf::from(arg);
            let path = if path.is_absolute() { path } else { cwd.join(path) };
            path.is_file().then_some(path)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_existing_files_only() {
        let dir = std::env::temp_dir().join(format!("rhwpp-args-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.hwp"), b"x").unwrap();
        let picked = document_args(["--flag", "a.hwp", "missing.hwp", ""], &dir);
        assert_eq!(picked, vec![dir.join("a.hwp")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_window_editing_a_document() {
        let state = AppState::new(&std::env::temp_dir().join("rhwpp-state-docs"));
        let doc = std::env::temp_dir().join("A.hwp");
        state.window_documents.lock().unwrap().insert("doc-1".into(), doc.clone());
        assert_eq!(state.window_for_document(&doc, None).as_deref(), Some("doc-1"));
        assert_eq!(state.window_for_document(&doc, Some("doc-1")), None);
        assert_eq!(state.window_for_document(&std::env::temp_dir().join("B.hwp"), None), None);
    }

    #[test]
    fn labels_first_window_main() {
        let dir = std::env::temp_dir();
        let state = AppState::new(&dir.join("rhwpp-state-test"));
        assert_eq!(state.next_window_label(), "main");
        assert_eq!(state.next_window_label(), "doc-1");
    }
}
