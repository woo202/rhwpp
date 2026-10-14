/**
 * 한글 식 문서 탭 (상태 표시줄 위).
 *
 * rhwpp 는 문서마다 창을 하나씩 쓰지만, 한글처럼 아래쪽에 열린 문서 탭을 보여 주고
 * 탭을 누르면 그 문서 창으로 전환한다. ×는 그 문서를 닫고(저장 확인), +는 새 창을 연다.
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { tabLabelFromTitle } from '../util';
import { onTitleChange } from './window-lifecycle';

interface DocumentWindow {
  label: string;
  title: string;
  focused: boolean;
}

const WINDOWS_CHANGED = 'rhwpp://windows-changed';

let strip: HTMLElement | null = null;
let refreshQueued = false;

function render(windows: DocumentWindow[]): void {
  if (!strip) return;
  const self = getCurrentWindow().label;
  const list = strip.querySelector<HTMLElement>('.rhwpp-doc-tab-list')!;
  list.replaceChildren(...windows.map((w) => {
    const { name, dirty } = tabLabelFromTitle(w.title);
    const tab = document.createElement('div');
    tab.className = 'rhwpp-doc-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(w.label === self));
    tab.classList.toggle('active', w.label === self);
    tab.title = w.title;
    const label = document.createElement('span');
    label.className = 'rhwpp-doc-tab-name';
    label.textContent = `${dirty ? '*' : ''}${name}`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'rhwpp-doc-tab-close';
    close.title = '문서 닫기';
    close.setAttribute('aria-label', `${name} 닫기`);
    close.textContent = '×';
    close.addEventListener('mousedown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      void invoke('request_close_window', { label: w.label });
    });
    tab.append(label, close);
    tab.addEventListener('mousedown', (e) => e.preventDefault());
    tab.addEventListener('click', () => {
      if (w.label !== self) void invoke('focus_window', { label: w.label });
    });
    return tab;
  }));
}

async function refresh(): Promise<void> {
  refreshQueued = false;
  try {
    render(await invoke<DocumentWindow[]>('list_documents'));
  } catch (error) {
    console.warn('[rhwpp] 문서 탭 갱신 실패', error);
  }
}

function queueRefresh(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  window.setTimeout(() => void refresh(), 60);
}

export function installDocumentTabs(onNewWindow: () => void): void {
  const statusBar = document.getElementById('status-bar');
  if (!statusBar || document.getElementById('rhwpp-doc-tabs')) return;
  strip = document.createElement('div');
  strip.id = 'rhwpp-doc-tabs';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', '열린 문서');
  const list = document.createElement('div');
  list.className = 'rhwpp-doc-tab-list';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'rhwpp-doc-tab-add';
  add.title = '새 창 (Ctrl+Alt+N)';
  add.setAttribute('aria-label', '새 창');
  add.textContent = '+';
  add.addEventListener('mousedown', (e) => e.preventDefault());
  add.addEventListener('click', onNewWindow);
  strip.append(list, add);
  statusBar.before(strip);

  void listen(WINDOWS_CHANGED, queueRefresh);
  // 내 제목이 바뀌면(파일명·변경 표시) 다른 창의 탭도 고치도록 알린다.
  onTitleChange(() => {
    window.setTimeout(() => void emit(WINDOWS_CHANGED), 150);
  });
  void getCurrentWindow().onFocusChanged(queueRefresh);
  queueRefresh();
}
