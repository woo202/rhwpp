/**
 * 창 수명주기: 닫기 전 저장 확인, 프로그램 끝(Alt+X), 창 제목 동기화.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { destroyWindow, isTauri, setWindowDocument } from '../native/ipc';
import { documentTitle } from '../util';
import * as studio from '../studio';

const APP_NAME = 'rhwpp';
const CLOSE_REQUEST_EVENT = 'rhwpp://close-request';

type TitleListener = (title: DocumentTitle) => void;

export interface DocumentTitle {
  fileName: string;
  directory: string;
  dirty: boolean;
  /** 제목 표시줄 문자열: "문서.hwp [C:\문서\] - rhwpp" */
  text: string;
}

const titleListeners = new Set<TitleListener>();
let lastTitle: DocumentTitle | null = null;

export function onTitleChange(listener: TitleListener): () => void {
  titleListeners.add(listener);
  if (lastTitle) listener(lastTitle);
  return () => titleListeners.delete(listener);
}

function computeTitle(): DocumentTitle {
  const hasDoc = studio.hasDocument();
  const fileName = hasDoc ? studio.fileName() || '빈 문서 1' : '';
  return documentTitle(fileName, studio.filePath(), hasDoc && studio.isDirty(), APP_NAME);
}

let reportedPath: string | null | undefined;

/** 이 창의 문서 경로를 셸에 알린다(같은 문서를 다른 창에서 열면 이 창으로 전환). */
function reportDocumentPath(): void {
  if (!isTauri()) return;
  const path = studio.filePath();
  if (path === reportedPath) return;
  reportedPath = path;
  void setWindowDocument(path).catch(() => undefined);
}

function refreshTitle(): void {
  reportDocumentPath();
  const next = computeTitle();
  if (lastTitle && lastTitle.text === next.text) return;
  lastTitle = next;
  for (const listener of titleListeners) listener(next);
  if (isTauri()) void getCurrentWindow().setTitle(next.text).catch(() => undefined);
}

export function installTitleSync(): void {
  // 스튜디오는 파일명이 바뀌면 document.title 을 고친다. 그 변화와 dirty 변화를 따라간다.
  const titleEl = document.querySelector('title');
  if (titleEl) new MutationObserver(refreshTitle).observe(titleEl, { childList: true, characterData: true, subtree: true });
  studio.on('document-dirty-changed', refreshTitle);
  studio.on('document-swapped', refreshTitle);
  studio.on('command-state-changed', refreshTitle);
  window.addEventListener('rhwpp:file-written', () => setTimeout(refreshTitle, 0));
  // 스튜디오는 문서 교체 이벤트 뒤에 파일 핸들을 지정하므로 가벼운 주기 확인으로 마저 따라간다.
  window.setInterval(refreshTitle, 500);
  refreshTitle();
}

let closing = false;

/** 저장 확인 뒤 이 창을 닫는다. 사용자가 취소하면 false. */
export async function closeThisWindow(): Promise<boolean> {
  if (closing) return false;
  closing = true;
  try {
    // 다른 창(문서 탭 ×, 끝)에서 요청받았을 때 저장 확인 대화상자가 가려지지 않게 앞으로 가져온다.
    if (isTauri() && studio.hasDocument() && studio.isDirty()) {
      const win = getCurrentWindow();
      await win.unminimize().catch(() => undefined);
      await win.setFocus().catch(() => undefined);
    }
    if (!await studio.confirmDiscardOrSave()) return false;
    await studio.discardRecoveryDraft();
    if (isTauri()) await destroyWindow();
    else window.close();
    return true;
  } finally {
    closing = false;
  }
}

export function installCloseGuard(): void {
  if (!isTauri()) return;
  const win = getCurrentWindow();
  void win.onCloseRequested((event) => {
    event.preventDefault();
    void closeThisWindow();
  });
  void win.listen(CLOSE_REQUEST_EVENT, () => {
    void closeThisWindow();
  });
}
