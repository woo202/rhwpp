/**
 * rhwpp 데스크톱 부트스트랩.
 *
 * index.html 에서 업스트림 스튜디오(main.ts)보다 **먼저** 실행된다(빌드 플러그인이 주입).
 * 그래서 이 파일의 최상위 코드는 동기적이어야 한다:
 *  1. 스튜디오가 시작하면서 찾는 브라우저 API(파일 선택기, launchQueue)를 네이티브 구현으로 바꾼다.
 *  2. 한글 2022 식 제목 표시줄과 탭 리본 DOM 을 미리 만든다(스튜디오가 리본 버튼을 직접 연결).
 *  3. 스튜디오 준비가 끝나면 창 수명주기·단축키·끌어다 놓기·데스크톱 명령을 붙인다.
 */
import './styles/hangul.css';
import { installDownloadInterceptor } from './native/downloads';
import { NativeFileHandle, prefetch } from './native/file-handle';
import { isTauri, openWindow, takeLaunchFiles } from './native/ipc';
import { installLaunchQueue, launchQueue } from './native/launch-queue';
import { markLaunchSettled } from './native/launch-state';
import { installNativePickers } from './native/pickers';
import * as studio from './studio';
import { samePath } from './util';
import { closeDocument, exitApp, newWindow, registerDesktopCommands } from './ui/commands';
import { installDocumentTabs } from './ui/doc-tabs';
import { installDrop } from './ui/drop';
import { hangulShortcuts, installKeymap, setDesktopShortcuts } from './ui/keymap';
import { installRibbon, syncRibbonStates } from './ui/ribbon';
import { installTitleBar } from './ui/titlebar';
import { installCloseGuard, installTitleSync } from './ui/window-lifecycle';

const tauri = isTauri();
const root = document.documentElement;
root.classList.add('rhwpp');
if (tauri) root.classList.add('rhwpp-desktop');

if (tauri) {
  installNativePickers();
  installLaunchQueue();
  installDownloadInterceptor();

  // 실행 인자/다른 창에서 넘어온 문서. 스튜디오 초기화와 병렬로 미리 읽어 둔다.
  void takeLaunchFiles().then((files) => {
    const [first, ...rest] = files;
    for (const file of rest) void openWindow([file.path]);
    if (!first) {
      markLaunchSettled();
      return;
    }
    prefetch(first.path);
    launchQueue.enqueue([new NativeFileHandle(first.path, first.name)]);
    waitForDocument(first.path, 10_000).then(markLaunchSettled);
  }).catch((error) => {
    console.error('[rhwpp] 시작 문서를 받지 못했습니다', error);
    markLaunchSettled();
  });

  // WebView2 기본 오른쪽 단추 메뉴(뒤로·새로 고침·다른 이름으로 저장…)를 막는다. 문서 영역의
  // 한글식 메뉴는 스튜디오가 따로 띄우고, 입력 칸에서는 잘라내기/붙이기 메뉴를 남긴다.
  window.addEventListener('contextmenu', (event) => {
    const target = event.target as Element | null;
    if (target?.closest?.('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
  });
} else {
  markLaunchSettled();
}

/** 시작 문서가 이 창에 열릴 때까지(또는 시간 초과·실패) 기다린다. */
function waitForDocument(path: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const current = studio.filePath();
      if ((current && samePath(current, path)) || Date.now() - started > timeoutMs) {
        window.clearInterval(timer);
        resolve();
      }
    }, 50);
  });
}

installTitleBar();
installRibbon();

void studio.whenStudioReady().then(() => {
  installTitleSync();
  registerDesktopCommands();
  setDesktopShortcuts(hangulShortcuts({ exit: exitApp, closeDocument, newWindow }));
  installKeymap();
  // 리본 활성 상태: 상태 변화가 잦으므로 프레임당 한 번만 갱신한다.
  let ribbonSyncQueued = false;
  const queueRibbonSync = () => {
    if (ribbonSyncQueued) return;
    ribbonSyncQueued = true;
    requestAnimationFrame(() => {
      ribbonSyncQueued = false;
      syncRibbonStates(studio.isEnabled);
    });
  };
  for (const event of ['command-state-changed', 'document-swapped', 'cursor-cell-changed', 'cursor-para-changed', 'cursor-format-changed']) {
    studio.on(event, queueRibbonSync);
  }
  document.getElementById('menu-bar')?.addEventListener('mousedown', () => setTimeout(queueRibbonSync, 0));
  document.addEventListener('mouseup', queueRibbonSync);
  document.addEventListener('keyup', queueRibbonSync);
  queueRibbonSync();
  if (tauri) {
    installCloseGuard();
    installDrop();
    installDocumentTabs(newWindow);
  }
});
