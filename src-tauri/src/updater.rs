//! 자동 업데이트.
//!
//! GitHub 최신 릴리스의 `SHA256SUMS.txt` 로 새 버전을 찾고, 설치 파일을 받아 SHA-256 을 맞춰
//! 본 뒤 프로그램을 끝낼 때 NSIS 설치 파일을 조용히 실행한다. 한 줄 설치 스크립트(install.ps1)와
//! 같은 신뢰 모델이다(HTTPS + 같은 릴리스의 체크섬).
//!
//! - 현재 사용자용 설치: 자동 업데이트가 켜져 있으면 끝낼 때 알아서 설치한다(관리자 권한 불필요).
//! - 모든 사용자용 설치: 관리자 확인이 필요하므로 사용자가 "지금 업데이트"를 눌렀을 때만 설치한다.
//! - 휴대용 실행 파일·MSI 설치: 새 버전이 있다고 알리기만 한다.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const RELEASES_URL: &str = "https://github.com/woo202/rhwpp/releases";
const SETUP_PREFIX: &str = "rhwpp_";
const SETUP_SUFFIX: &str = "_x64-setup.exe";
/// 창에 보내는 이벤트. 받은 창은 `update_take_notice` 로 알림을 가져간다.
pub const UPDATE_EVENT: &str = "rhwpp://update";
/// 자동 확인 주기.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// 자동 확인을 이보다 자주 하지 않는다(수동 확인은 예외).
const MIN_AUTO_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// 설치 파일 크기 상한(잘못된 응답으로 디스크를 채우지 않게).
const MAX_SETUP_BYTES: usize = 300 * 1024 * 1024;
const SETTINGS_FILE: &str = "update-settings.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum InstallKind {
    /// NSIS 현재 사용자 설치(%LOCALAPPDATA%\Programs\rhwpp).
    CurrentUser,
    /// NSIS 모든 사용자 설치(Program Files\rhwpp).
    AllUsers,
    /// 휴대용 실행 파일, MSI 설치, 개발 빌드: 스스로 설치하지 않는다.
    Portable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateState {
    /// 아직 확인하지 않았다.
    Unknown,
    UpToDate,
    /// 새 버전을 받는 중이다(알리지 않는다).
    Downloading,
    /// 새 버전이 있지만 받지 않았다(휴대용·MSI, 또는 받기 실패).
    Available,
    /// 받아서 확인을 마쳤다. 설치만 남았다.
    Ready,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub latest: Option<String>,
    pub state: UpdateState,
    pub kind: InstallKind,
    pub auto: bool,
    /// 프로그램을 끝내면 저절로 설치되는가.
    pub installs_on_exit: bool,
    pub error: Option<String>,
    pub releases_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseEntry {
    pub version: Version,
    pub setup_name: String,
    pub sha256: String,
}

struct Ready {
    version: Version,
    path: PathBuf,
    sha256: String,
}

#[derive(Default)]
struct Inner {
    latest: Option<ReleaseEntry>,
    ready: Option<Ready>,
    state: Option<UpdateState>,
    error: Option<String>,
    last_check: Option<Instant>,
    /// 사용자에게 이미 알린 버전과 상태(창마다, 확인할 때마다 거듭 알리지 않게).
    /// 상태도 함께 보므로 "새 버전 있음"을 알린 뒤 받기를 마치면 "받았음"을 다시 알린다.
    notified: Option<(Version, UpdateState)>,
    /// "지금 다시 시작"을 눌렀다: 끝낼 때 설치하고 다시 실행한다. 저장 확인에서 취소하면 지운다.
    install_requested: bool,
}

impl Inner {
    /// 아직 알리지 않은 "받았음/새 버전 있음"이면 알린 것으로 표시하고 true.
    fn take_notice(&mut self) -> bool {
        let Some(state) = self.state else { return false };
        if !matches!(state, UpdateState::Ready | UpdateState::Available) {
            return false;
        }
        let Some(latest) = self.latest.as_ref().map(|l| l.version.clone()) else { return false };
        let key = (latest, state);
        if self.notified.as_ref() == Some(&key) {
            return false;
        }
        self.notified = Some(key);
        true
    }
}

pub struct Updater {
    inner: Mutex<Inner>,
    auto: AtomicBool,
    /// 확인·받기는 한 번에 하나. 수동 확인은 진행 중인 확인이 끝나기를 기다린다.
    check_lock: tokio::sync::Mutex<()>,
    /// 사용자가 마지막 창을 닫아 끝내는 중이다(Windows 종료·Restart Manager 로 끝날 때는 아니다).
    exit_requested: AtomicBool,
    kind: InstallKind,
    current: Version,
    settings_path: PathBuf,
    download_dir: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct Settings {
    auto: bool,
}

impl Updater {
    pub fn new(current: Version, data_dir: &Path, local_data_dir: &Path) -> Self {
        let settings_path = data_dir.join(SETTINGS_FILE);
        let auto = std::fs::read(&settings_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .map(|s| s.auto)
            .unwrap_or(true);
        Self {
            inner: Mutex::new(Inner::default()),
            auto: AtomicBool::new(auto),
            check_lock: tokio::sync::Mutex::new(()),
            exit_requested: AtomicBool::new(false),
            kind: detect_install_kind(),
            current,
            settings_path,
            download_dir: local_data_dir.join("updates"),
        }
    }

    pub fn auto(&self) -> bool {
        self.auto.load(Ordering::SeqCst)
    }

    fn set_auto(&self, enabled: bool) -> Result<(), String> {
        self.auto.store(enabled, Ordering::SeqCst);
        if let Some(dir) = self.settings_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_vec(&Settings { auto: enabled }).map_err(|e| e.to_string())?;
        std::fs::write(&self.settings_path, json).map_err(|e| e.to_string())
    }

    pub fn status(&self) -> UpdateStatus {
        let inner = self.inner.lock().unwrap();
        self.status_locked(&inner)
    }

    fn status_locked(&self, inner: &Inner) -> UpdateStatus {
        let state = inner.state.unwrap_or(UpdateState::Unknown);
        let ready = state == UpdateState::Ready && inner.ready.is_some();
        UpdateStatus {
            current: self.current.to_string(),
            latest: inner.latest.as_ref().map(|l| l.version.to_string()),
            state,
            kind: self.kind,
            auto: self.auto(),
            installs_on_exit: ready && should_install_on_exit(self.kind, self.auto(), inner.install_requested),
            error: inner.error.clone(),
            releases_url: RELEASES_URL.to_string(),
        }
    }
}

/// 끝낼 때 설치할지. 모든 사용자 설치는 관리자 확인 창이 뜨므로 사용자가 요청했을 때만.
pub fn should_install_on_exit(kind: InstallKind, auto: bool, requested: bool) -> bool {
    match kind {
        InstallKind::CurrentUser => auto || requested,
        InstallKind::AllUsers => requested,
        InstallKind::Portable => false,
    }
}

/// `SHA256SUMS.txt` 에서 x64 설치 파일 항목을 찾는다(여럿이면 가장 높은 버전).
pub fn parse_checksums(text: &str) -> Option<ReleaseEntry> {
    let mut best: Option<ReleaseEntry> = None;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(hash), Some(name)) = (parts.next(), parts.next()) else { continue };
        let name = name.trim_start_matches('*');
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let Some(version) = name
            .strip_prefix(SETUP_PREFIX)
            .and_then(|rest| rest.strip_suffix(SETUP_SUFFIX))
            .and_then(|v| Version::parse(v).ok())
        else {
            continue;
        };
        if best.as_ref().is_none_or(|b| version > b.version) {
            best = Some(ReleaseEntry {
                version,
                setup_name: name.to_string(),
                sha256: hash.to_ascii_lowercase(),
            });
        }
    }
    best
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn file_sha256(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| sha256_hex(&bytes))
}

/// 설치 파일에 줄 인수. `/UPDATE` 는 사용자가 지운 바로 가기를 되살리지 않는다.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn installer_args(kind: InstallKind, restart: bool) -> Vec<&'static str> {
    let mut args = vec!["/S", "/UPDATE"];
    args.push(if kind == InstallKind::AllUsers { "/AllUsers" } else { "/CurrentUser" });
    if restart {
        args.push("/R");
    }
    args
}

/// 시험용 주소 바꾸기(`RHWPP_UPDATE_URL`). 이 PC 안의 시험 서버만 허용한다.
fn test_base_url() -> Option<String> {
    let url = std::env::var("RHWPP_UPDATE_URL").ok()?;
    is_loopback_http(&url).then(|| url.trim_end_matches('/').to_string())
}

pub fn is_loopback_http(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    ["http://127.0.0.1:", "http://localhost:", "http://127.0.0.1/", "http://localhost/"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

fn checksums_url() -> String {
    match test_base_url() {
        Some(base) => format!("{base}/SHA256SUMS.txt"),
        None => format!("{RELEASES_URL}/latest/download/SHA256SUMS.txt"),
    }
}

fn setup_url(entry: &ReleaseEntry) -> String {
    match test_base_url() {
        Some(base) => format!("{base}/{}", entry.setup_name),
        None => format!("{RELEASES_URL}/download/v{}/{}", entry.version, entry.setup_name),
    }
}

/// 요청에 쓸 프록시. `System` 이면 reqwest 의 시스템 프록시(수동으로 적은 프록시) 처리에 맡긴다.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
enum ProxyChoice {
    System,
    Direct,
    Named(String),
}

fn http_client(current: &Version, proxy: &ProxyChoice) -> Result<reqwest::Client, String> {
    let builder = match proxy {
        ProxyChoice::System => reqwest::Client::builder(),
        ProxyChoice::Direct => reqwest::Client::builder().no_proxy(),
        ProxyChoice::Named(url) => reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(url.as_str()).map_err(|e| e.to_string())?),
    };
    builder
        .user_agent(format!("rhwpp/{current}"))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(15 * 60))
        // HTTPS 에서 HTTP 로 넘어가는 리디렉션은 따르지 않는다.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("리디렉션이 너무 많습니다")
            } else if attempt.url().scheme() != "https" && !is_loopback_http(attempt.url().as_str()) {
                attempt.error("안전하지 않은 주소로 넘어가려 합니다")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

/// 자동 프록시 설정(PAC 스크립트, "자동으로 설정 검색")이 있으면 그 결과를 따른다.
/// reqwest 는 수동으로 적은 프록시만 읽으므로 WinHTTP 로 주소별 프록시를 구한다.
async fn proxy_for(url: &str) -> ProxyChoice {
    if test_base_url().is_some() {
        return ProxyChoice::Direct;
    }
    let url = url.to_string();
    tauri::async_runtime::spawn_blocking(move || resolve_auto_proxy(&url))
        .await
        .unwrap_or(ProxyChoice::System)
}

#[cfg(windows)]
fn resolve_auto_proxy(url: &str) -> ProxyChoice {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::Networking::WinHttp::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    /// WinHTTP 가 GlobalAlloc 으로 준 문자열을 읽고 풀어 준다.
    unsafe fn take(ptr: *mut u16) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        let len = (0..).take_while(|&i| *ptr.add(i) != 0).count();
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
        GlobalFree(ptr.cast());
        Some(text)
    }

    // SAFETY: 구조체는 0 으로 초기화한 뒤 WinHTTP 가 채우고, 돌려받은 문자열은 모두 take() 로 푼다.
    unsafe {
        let mut ie: WINHTTP_CURRENT_USER_IE_PROXY_CONFIG = std::mem::zeroed();
        if WinHttpGetIEProxyConfigForCurrentUser(&mut ie) == 0 {
            return ProxyChoice::System;
        }
        let auto_detect = ie.fAutoDetect != 0;
        let config_url = take(ie.lpszAutoConfigUrl);
        let _ = take(ie.lpszProxy);
        let _ = take(ie.lpszProxyBypass);
        if !auto_detect && config_url.is_none() {
            return ProxyChoice::System;
        }

        let agent = wide("rhwpp-updater");
        let session = WinHttpOpen(agent.as_ptr(), WINHTTP_ACCESS_TYPE_NO_PROXY, std::ptr::null(), std::ptr::null(), 0);
        if session.is_null() {
            return ProxyChoice::System;
        }
        let config_wide = config_url.as_deref().map(wide);
        let mut options: WINHTTP_AUTOPROXY_OPTIONS = std::mem::zeroed();
        if let Some(config) = config_wide.as_ref() {
            options.dwFlags |= WINHTTP_AUTOPROXY_CONFIG_URL;
            options.lpszAutoConfigUrl = config.as_ptr();
        }
        if auto_detect {
            options.dwFlags |= WINHTTP_AUTOPROXY_AUTO_DETECT;
            options.dwAutoDetectFlags = WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A;
        }
        options.fAutoLogonIfChallenged = 1;
        let target = wide(url);
        let mut info: WINHTTP_PROXY_INFO = std::mem::zeroed();
        let found = WinHttpGetProxyForUrl(session, target.as_ptr(), &mut options, &mut info) != 0;
        WinHttpCloseHandle(session);
        if !found {
            // 자동 검색 실패(대부분의 가정용 PC): 수동 설정이나 직접 연결로.
            return ProxyChoice::System;
        }
        let proxy = take(info.lpszProxy);
        let _ = take(info.lpszProxyBypass);
        match (info.dwAccessType, proxy) {
            (WINHTTP_ACCESS_TYPE_NAMED_PROXY, Some(list)) => {
                first_proxy(&list).map(ProxyChoice::Named).unwrap_or(ProxyChoice::System)
            }
            _ => ProxyChoice::Direct,
        }
    }
}

#[cfg(not(windows))]
fn resolve_auto_proxy(_url: &str) -> ProxyChoice {
    ProxyChoice::System
}

/// WinHTTP 프록시 목록("a:8080; b:8080", "https=a:443")에서 첫 프록시를 reqwest 주소로.
#[cfg_attr(not(windows), allow(dead_code))]
fn first_proxy(list: &str) -> Option<String> {
    let entry = list.split([';', ' ', '\t']).map(str::trim).find(|e| !e.is_empty())?;
    let entry = entry.split_once('=').map_or(entry, |(_, v)| v);
    if entry.is_empty() {
        return None;
    }
    Some(if entry.contains("://") { entry.to_string() } else { format!("http://{entry}") })
}

async fn fetch(current: &Version, url: &str) -> Result<Vec<u8>, String> {
    let client = http_client(current, &proxy_for(url).await)?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("서버에 연결하지 못했습니다: {e}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("아직 게시된 릴리스가 없습니다.".into());
    }
    if !status.is_success() {
        return Err(format!("서버 응답 {status}"));
    }
    if response.content_length().is_some_and(|n| n as usize > MAX_SETUP_BYTES) {
        return Err("파일이 너무 큽니다.".into());
    }
    let bytes = response.bytes().await.map_err(|e| format!("받는 중 끊겼습니다: {e}"))?;
    if bytes.len() > MAX_SETUP_BYTES {
        return Err("파일이 너무 큽니다.".into());
    }
    Ok(bytes.to_vec())
}

fn updater<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, Updater> {
    app.state::<Updater>()
}

/// 받은 설치 파일 폴더를 비운다(`keep` 은 남김).
fn clean_download_dir(dir: &Path, keep: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if Some(path.as_path()) != keep {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// 새 버전을 확인하고, 설치할 수 있는 경우 받아 둔다. 알릴 것이 생기면 창에 이벤트를 보낸다.
pub async fn check<R: Runtime>(app: &AppHandle<R>, manual: bool) -> UpdateStatus {
    let updater = updater(app);
    let _guard = if manual {
        // 진행 중인 확인(받기 포함)이 있으면 끝나기를 기다렸다가 새로 확인한다.
        updater.check_lock.lock().await
    } else {
        let recent = {
            let inner = updater.inner.lock().unwrap();
            inner.last_check.is_some_and(|t| t.elapsed() < MIN_AUTO_INTERVAL)
        };
        if recent {
            return updater.status();
        }
        match updater.check_lock.try_lock() {
            Ok(guard) => guard,
            Err(_) => return updater.status(),
        }
    };
    let result = check_inner(&updater).await;

    let status = {
        let mut inner = updater.inner.lock().unwrap();
        inner.last_check = Some(Instant::now());
        match result {
            Ok(()) => inner.error = None,
            Err(error) => {
                match inner.state {
                    // 앞서 받아 둔 업데이트는 그대로 둔다.
                    Some(UpdateState::Ready) if inner.ready.is_some() => {}
                    // 새 버전은 찾았지만 받기에 실패했다.
                    _ if inner.latest.is_some() => inner.state = Some(UpdateState::Available),
                    _ => inner.state = Some(UpdateState::Error),
                }
                inner.error = Some(error);
            }
        }
        updater.status_locked(&inner)
    };
    if matches!(status.state, UpdateState::Ready | UpdateState::Available) {
        let _ = app.emit(UPDATE_EVENT, ());
    }
    status
}

async fn check_inner(updater: &Updater) -> Result<(), String> {
    let sums = fetch(&updater.current, &checksums_url()).await?;
    let text = String::from_utf8_lossy(&sums);
    let entry = parse_checksums(&text).ok_or("릴리스에 x64 설치 파일 정보가 없습니다.")?;

    if entry.version <= updater.current {
        let mut inner = updater.inner.lock().unwrap();
        inner.latest = None;
        inner.ready = None;
        inner.state = Some(UpdateState::UpToDate);
        drop(inner);
        clean_download_dir(&updater.download_dir, None);
        return Ok(());
    }

    {
        let mut inner = updater.inner.lock().unwrap();
        let already = inner.ready.as_ref().is_some_and(|r| r.version == entry.version);
        inner.latest = Some(entry.clone());
        if already {
            inner.state = Some(UpdateState::Ready);
            return Ok(());
        }
        inner.ready = None;
        inner.state = Some(if updater.kind == InstallKind::Portable {
            UpdateState::Available
        } else {
            UpdateState::Downloading
        });
    }
    if updater.kind == InstallKind::Portable {
        return Ok(());
    }

    std::fs::create_dir_all(&updater.download_dir).map_err(|e| e.to_string())?;
    let target = updater.download_dir.join(&entry.setup_name);
    clean_download_dir(&updater.download_dir, Some(&target));
    if file_sha256(&target).as_deref() != Some(entry.sha256.as_str()) {
        let bytes = fetch(&updater.current, &setup_url(&entry)).await?;
        let actual = sha256_hex(&bytes);
        if actual != entry.sha256 {
            return Err(format!("받은 설치 파일이 손상되었거나 바뀌었습니다(SHA-256 {actual})."));
        }
        let partial = target.with_extension("part");
        std::fs::write(&partial, &bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&partial, &target).map_err(|e| e.to_string())?;
    }

    let mut inner = updater.inner.lock().unwrap();
    inner.ready = Some(Ready { version: entry.version.clone(), path: target, sha256: entry.sha256 });
    inner.state = Some(UpdateState::Ready);
    Ok(())
}

/// 앱이 켜져 있는 동안 주기적으로 확인한다.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let delay = std::env::var("RHWPP_UPDATE_DELAY_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(20);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(delay)).await;
        loop {
            if updater(&app).auto() {
                check(&app, false).await;
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// 마지막 창이 닫혀 끝나기 시작했다(`RunEvent::ExitRequested`). Windows 종료·로그오프나
/// Restart Manager(다른 설치·제거 프로그램)가 끝낼 때는 이 단계 없이 바로 `Exit` 가 온다.
pub fn note_exit_requested<R: Runtime>(app: &AppHandle<R>) {
    updater(app).exit_requested.store(true, Ordering::SeqCst);
}

#[cfg(windows)]
fn system_shutting_down() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    // SAFETY: 인수 없는 단순 조회.
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}

#[cfg(not(windows))]
fn system_shutting_down() -> bool {
    false
}

/// 사용자가 프로그램을 끝낼 때(모든 창이 닫힌 뒤) 받아 둔 업데이트를 설치한다.
pub fn on_exit<R: Runtime>(app: &AppHandle<R>) {
    let updater = updater(app);
    // 끝나는 세션이나 다른 설치 프로그램과 겹쳐 설치하다 끊기면 실행 파일이 망가진다.
    if !updater.exit_requested.load(Ordering::SeqCst) || system_shutting_down() {
        return;
    }
    let inner = updater.inner.lock().unwrap();
    let Some(ready) = inner.ready.as_ref() else { return };
    if inner.state != Some(UpdateState::Ready)
        || !should_install_on_exit(updater.kind, updater.auto(), inner.install_requested)
    {
        return;
    }
    // 받은 뒤 파일이 바뀌지 않았는지 실행 직전에 다시 확인한다.
    if file_sha256(&ready.path).as_deref() != Some(ready.sha256.as_str()) {
        return;
    }
    if let Err(error) = launch_installer(&ready.path, updater.kind, inner.install_requested) {
        eprintln!("[rhwpp] 업데이트 설치 파일을 실행하지 못했습니다: {error}");
    }
}

#[cfg(windows)]
fn launch_installer(path: &Path, kind: InstallKind, restart: bool) -> Result<(), String> {
    let args = installer_args(kind, restart);
    match kind {
        InstallKind::CurrentUser => {
            // 설치 파일은 모든 사용자 설치도 고를 수 있게 가장 높은 권한을 요청한다. 현재 사용자
            // 설치에는 필요 없으므로 관리자 확인 창 없이 실행한다.
            std::process::Command::new(path)
                .args(&args)
                .env("__COMPAT_LAYER", "RunAsInvoker")
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        InstallKind::AllUsers => shell_execute_runas(path, &args.join(" ")),
        InstallKind::Portable => Err("설치된 프로그램이 아닙니다.".into()),
    }
}

#[cfg(not(windows))]
fn launch_installer(_path: &Path, _kind: InstallKind, _restart: bool) -> Result<(), String> {
    Err("Windows 에서만 설치할 수 있습니다.".into())
}

#[cfg(windows)]
fn shell_execute_runas(path: &Path, params: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let verb = wide(std::ffi::OsStr::new("runas"));
    let file = wide(path.as_os_str());
    let params = wide(std::ffi::OsStr::new(params));
    // SAFETY: 모든 문자열은 NUL 로 끝나는 UTF-16 버퍼이고 호출 동안 살아 있다.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            params.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize > 32 {
        Ok(())
    } else {
        Err(format!("ShellExecute 실패 ({})", result as isize))
    }
}

/// 지금 실행 중인 rhwpp.exe 가 NSIS 로 설치된 것인지 Uninstall 등록 정보로 판단한다.
#[cfg(windows)]
fn detect_install_kind() -> InstallKind {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;

    let Ok(exe) = std::env::current_exe() else { return InstallKind::Portable };
    let key_path = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\rhwpp";
    let candidates = [
        (HKEY_CURRENT_USER, InstallKind::CurrentUser),
        (HKEY_LOCAL_MACHINE, InstallKind::AllUsers),
    ];
    for (hive, kind) in candidates {
        let location = RegKey::predef(hive)
            .open_subkey_with_flags(key_path, KEY_READ | KEY_WOW64_64KEY)
            .and_then(|key| key.get_value::<String, _>("InstallLocation"));
        if let Ok(location) = location {
            if is_same_install(&location, &exe) {
                return kind;
            }
        }
    }
    InstallKind::Portable
}

#[cfg(not(windows))]
fn detect_install_kind() -> InstallKind {
    InstallKind::Portable
}

/// 등록된 설치 폴더(따옴표가 붙어 있을 수 있다)의 rhwpp.exe 가 지금 실행 파일인가.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_same_install(location: &str, exe: &Path) -> bool {
    let dir = location.trim().trim_matches('"').trim_end_matches(['\\', '/']);
    if dir.is_empty() {
        return false;
    }
    let installed = crate::access::normalize(&Path::new(dir).join("rhwpp.exe"));
    installed == crate::access::normalize(exe)
}

// ── 명령 ────────────────────────────────────────────────

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    updater(&app).status()
}

/// 사용자가 고른 "업데이트 확인".
#[tauri::command]
pub async fn update_check(app: AppHandle) -> UpdateStatus {
    let status = check(&app, true).await;
    // 수동으로 확인한 결과는 그 자리에서 보여 주므로 같은 알림을 다시 띄우지 않는다.
    if let Some(latest) = status.latest.as_ref().and_then(|v| Version::parse(v).ok()) {
        updater(&app).inner.lock().unwrap().notified = Some((latest, status.state));
    }
    status
}

/// 아직 알리지 않은 새 버전이 있으면 한 번만 돌려준다(여러 창 중 한 곳에만 알림이 뜨게).
#[tauri::command]
pub fn update_take_notice(app: AppHandle) -> Option<UpdateStatus> {
    let updater = updater(&app);
    let mut inner = updater.inner.lock().unwrap();
    inner.take_notice().then(|| updater.status_locked(&inner))
}

#[tauri::command]
pub fn update_set_auto(app: AppHandle, enabled: bool) -> Result<UpdateStatus, String> {
    let updater = updater(&app);
    updater.set_auto(enabled)?;
    Ok(updater.status())
}

/// "지금 다시 시작": 창을 모두 닫고(저장 확인 포함) 끝날 때 설치한 뒤 다시 실행한다.
#[tauri::command]
pub fn update_install_now(app: AppHandle) -> Result<(), String> {
    {
        let updater = updater(&app);
        let mut inner = updater.inner.lock().unwrap();
        if inner.ready.is_none() || inner.state != Some(UpdateState::Ready) {
            return Err("받아 둔 업데이트가 없습니다.".into());
        }
        if updater.kind == InstallKind::Portable {
            return Err("설치된 프로그램이 아니라 스스로 업데이트할 수 없습니다.".into());
        }
        inner.install_requested = true;
    }
    crate::windows::request_quit(app);
    Ok(())
}

/// 저장 확인에서 취소해 끝내지 않게 되었다: "지금 다시 시작" 요청을 거둔다.
#[tauri::command]
pub fn update_cancel_install(app: AppHandle) {
    updater(&app).inner.lock().unwrap().install_requested = false;
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUMS: &str = "\
0000000000000000000000000000000000000000000000000000000000000000  install.ps1\r\n\
ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789 *rhwpp_0.2.0_x64-setup.exe\r\n\
1111111111111111111111111111111111111111111111111111111111111111  rhwpp_0.2.0_x64_ko-KR.msi\n\
2222222222222222222222222222222222222222222222222222222222222222  rhwpp-portable-x64.zip\n";

    #[test]
    fn parses_setup_entry_from_checksums() {
        let entry = parse_checksums(SUMS).unwrap();
        assert_eq!(entry.version, Version::parse("0.2.0").unwrap());
        assert_eq!(entry.setup_name, "rhwpp_0.2.0_x64-setup.exe");
        assert_eq!(entry.sha256, "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
    }

    #[test]
    fn picks_highest_version_and_skips_junk() {
        let text = format!(
            "{h}  rhwpp_0.9.0_x64-setup.exe\n{h}  rhwpp_0.10.0_x64-setup.exe\nzz  rhwpp_9.0.0_x64-setup.exe\n{h}  rhwpp_x_x64-setup.exe\n{h}  rhwpp_1.0.0-rc.1_x64-setup.exe\n",
            h = "a".repeat(64)
        );
        assert_eq!(parse_checksums(&text).unwrap().version, Version::parse("1.0.0-rc.1").unwrap());
        assert!(parse_checksums("nothing here").is_none());
        assert!(Version::parse("1.0.0-10").unwrap() > Version::parse("1.0.0-9").unwrap());
    }

    #[test]
    fn hashes_bytes() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn install_on_exit_policy() {
        assert!(should_install_on_exit(InstallKind::CurrentUser, true, false));
        assert!(!should_install_on_exit(InstallKind::CurrentUser, false, false));
        assert!(should_install_on_exit(InstallKind::CurrentUser, false, true));
        assert!(!should_install_on_exit(InstallKind::AllUsers, true, false));
        assert!(should_install_on_exit(InstallKind::AllUsers, true, true));
        assert!(!should_install_on_exit(InstallKind::Portable, true, true));
    }

    #[test]
    fn builds_installer_arguments() {
        assert_eq!(installer_args(InstallKind::CurrentUser, false), ["/S", "/UPDATE", "/CurrentUser"]);
        assert_eq!(installer_args(InstallKind::AllUsers, true), ["/S", "/UPDATE", "/AllUsers", "/R"]);
    }

    #[test]
    fn notices_once_per_version_and_state() {
        let entry = parse_checksums(SUMS).unwrap();
        let mut inner = Inner { latest: Some(entry), state: Some(UpdateState::Downloading), ..Inner::default() };
        assert!(!inner.take_notice(), "받는 중에는 알리지 않는다");
        inner.state = Some(UpdateState::Available);
        assert!(inner.take_notice());
        assert!(!inner.take_notice(), "같은 알림은 한 번만");
        inner.state = Some(UpdateState::Ready);
        assert!(inner.take_notice(), "'새 버전 있음' 뒤에 '받았음'은 다시 알린다");
        assert!(!inner.take_notice());
    }

    #[test]
    fn picks_first_proxy_from_winhttp_list() {
        assert_eq!(first_proxy("proxy.corp:8080; backup:3128").as_deref(), Some("http://proxy.corp:8080"));
        assert_eq!(first_proxy("https=secure:443").as_deref(), Some("http://secure:443"));
        assert_eq!(first_proxy("  ").as_deref(), None);
        assert_eq!(first_proxy("http://p:1").as_deref(), Some("http://p:1"));
    }

    #[test]
    fn only_loopback_test_urls() {
        assert!(is_loopback_http("http://127.0.0.1:8766"));
        assert!(is_loopback_http("http://localhost:1/x"));
        assert!(!is_loopback_http("http://127.0.0.1.evil.com/"));
        assert!(!is_loopback_http("https://example.com"));
        assert!(!is_loopback_http("http://localhost.evil.com:80/"));
    }

    #[test]
    fn matches_registered_install_location() {
        let base = std::env::temp_dir().join("rhwpp-update-test");
        let exe = base.join("rhwpp.exe");
        let quoted = format!("\"{}\"", base.display());
        assert!(is_same_install(&quoted, &exe));
        assert!(is_same_install(&format!("{}{}", base.display(), std::path::MAIN_SEPARATOR), &exe));
        assert!(!is_same_install("", &exe));
        assert!(!is_same_install(&base.join("other").display().to_string(), &exe));
    }
}
