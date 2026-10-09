//! 파일 접근 범위(scope).
//!
//! 웹뷰는 임의 경로를 읽거나 쓸 수 없다. 다음 경로만 허용한다.
//!  - 사용자가 열기/저장 대화상자에서 고른 경로
//!  - 실행 인자(탐색기 더블클릭, 연결 프로그램)로 넘어온 경로
//!  - 창에 끌어다 놓은 경로
//!  - 위 경로 중 실제로 열거나 저장한 적 있는 문서(최근 문서 재열기용, 디스크에 보존)

use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

/// 디스크에 보존하는 문서 경로 수 상한.
const MAX_KNOWN_DOCUMENTS: usize = 500;
const KNOWN_DOCUMENTS_FILE: &str = "known-documents.json";

#[derive(Default)]
pub struct AccessList {
    granted: HashSet<PathBuf>,
    known: VecDeque<PathBuf>,
    store: Option<PathBuf>,
}

impl AccessList {
    pub fn load(data_dir: &Path) -> Self {
        let store = data_dir.join(KNOWN_DOCUMENTS_FILE);
        let known = fs::read(&store)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<PathBuf>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .take(MAX_KNOWN_DOCUMENTS)
            .collect();
        Self {
            granted: HashSet::new(),
            known,
            store: Some(store),
        }
    }

    /// 이번 실행 동안 접근을 허용한다.
    pub fn grant(&mut self, path: &Path) {
        self.granted.insert(normalize(path));
    }

    pub fn is_allowed(&self, path: &Path) -> bool {
        let path = normalize(path);
        self.granted.contains(&path) || self.known.iter().any(|known| *known == path)
    }

    /// 실제로 열거나 저장한 문서를 기억한다(다음 실행의 최근 문서 재열기).
    /// HWP/HWPX/HML 문서만 디스크에 남기고, 그림 등은 이번 실행 동안만 허용한다.
    pub fn remember(&mut self, path: &Path) {
        let path = normalize(path);
        self.granted.insert(path.clone());
        if !is_document_path(&path) {
            return;
        }
        self.known.retain(|known| *known != path);
        self.known.push_front(path);
        self.known.truncate(MAX_KNOWN_DOCUMENTS);
        self.persist();
    }

    fn persist(&self) {
        let Some(store) = &self.store else { return };
        if let Some(parent) = store.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let list: Vec<&PathBuf> = self.known.iter().collect();
        if let Ok(json) = serde_json::to_vec_pretty(&list) {
            let _ = fs::write(store, json);
        }
    }
}

/// 최근 문서로 기억할 만한 문서 형식인가.
pub fn is_document_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "hwp" | "hwpx" | "hml"))
        .unwrap_or(false)
}

/// 비교용 경로 정규화. Windows 경로는 대소문자를 구분하지 않는다.
pub fn normalize(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut clean = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other.as_os_str()),
        }
    }
    if cfg!(windows) {
        PathBuf::from(clean.to_string_lossy().to_lowercase())
    } else {
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_and_remembers_paths() {
        let dir = std::env::temp_dir().join(format!("rhwpp-access-{}", std::process::id()));
        let mut access = AccessList::load(&dir);
        let doc = dir.join("a").join("..").join("doc.hwp");
        assert!(!access.is_allowed(&doc));
        access.grant(&doc);
        assert!(access.is_allowed(&dir.join("doc.hwp")));

        let other = dir.join("other.hwpx");
        access.remember(&other);
        let picture = dir.join("photo.png");
        access.remember(&picture);
        assert!(access.is_allowed(&picture));
        let reloaded = AccessList::load(&dir);
        assert!(reloaded.is_allowed(&other));
        assert!(!reloaded.is_allowed(&doc));
        assert!(!reloaded.is_allowed(&picture), "그림 경로는 디스크에 남기지 않는다");
        let _ = fs::remove_dir_all(&dir);
    }
}
