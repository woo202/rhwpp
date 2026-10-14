/**
 * 한글 2022 식 제목 표시줄.
 *
 *  [앱 아이콘][빠른 실행 도구: 새 문서·불러오기·저장·인쇄·되돌리기·다시 실행]
 *              ── 문서이름.hwp [C:\폴더\] - rhwpp ──            [?][— ▢ ✕]
 *
 * 창 테두리는 Windows 가 그리지 않으므로(decorations: false) 끌기·두 번 눌러 최대화·창 단추를
 * 여기서 처리한다. Tauri 밖(브라우저 미리보기)에서는 창 단추를 숨긴다.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import appIconUrl from '../assets/app-icon-64.png';
import { isTauri } from '../native/ipc';
import * as studio from '../studio';
import { CAPTION_ICONS, ICONS } from './icons';
import { onTitleChange } from './window-lifecycle';

interface QuickButton {
  cmd: string;
  title: string;
  sprite?: string;
  icon?: string;
}

const QUICK_ACCESS: QuickButton[] = [
  { cmd: 'file:new-doc', title: '새 문서 (Alt+N)', icon: 'newDoc' },
  { cmd: 'file:open', title: '불러오기 (Alt+O)', icon: 'open' },
  { cmd: 'file:save', title: '저장하기 (Alt+S)', sprite: 'icon-save' },
  { cmd: 'file:print', title: '인쇄 (Alt+P)', icon: 'print' },
  { cmd: 'edit:undo', title: '되돌리기 (Ctrl+Z)', sprite: 'icon-undo' },
  { cmd: 'edit:redo', title: '다시 실행 (Ctrl+Shift+Z)', sprite: 'icon-redo' },
];

function quickButton(button: QuickButton): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'rhwpp-qat-btn';
  el.title = button.title;
  el.dataset.qatCmd = button.cmd;
  el.innerHTML = button.sprite
    ? `<span class="tb-sprite ${button.sprite}"></span>`
    : (ICONS[button.icon ?? ''] ?? '');
  el.addEventListener('mousedown', (e) => e.preventDefault()); // 편집 영역 포커스 유지
  el.addEventListener('click', () => studio.execute(button.cmd));
  return el;
}

function captionButton(kind: keyof typeof CAPTION_ICONS, label: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `rhwpp-caption-btn rhwpp-caption-${kind}`;
  el.title = label;
  el.setAttribute('aria-label', label);
  el.innerHTML = CAPTION_ICONS[kind];
  return el;
}

export function installTitleBar(): void {
  const root = document.getElementById('studio-root');
  if (!root || document.getElementById('rhwpp-titlebar')) return;

  const bar = document.createElement('div');
  bar.id = 'rhwpp-titlebar';
  bar.setAttribute('data-tauri-drag-region', '');

  const icon = document.createElement('img');
  icon.className = 'rhwpp-app-icon';
  icon.src = appIconUrl;
  icon.alt = '';
  icon.draggable = false;

  const qat = document.createElement('div');
  qat.className = 'rhwpp-qat';
  qat.setAttribute('role', 'toolbar');
  qat.setAttribute('aria-label', '빠른 실행 도구');
  for (const button of QUICK_ACCESS) qat.append(quickButton(button));

  const title = document.createElement('div');
  title.className = 'rhwpp-title';
  title.setAttribute('data-tauri-drag-region', '');
  const titleName = document.createElement('span');
  titleName.className = 'rhwpp-title-name';
  titleName.setAttribute('data-tauri-drag-region', '');
  const titlePath = document.createElement('span');
  titlePath.className = 'rhwpp-title-path';
  titlePath.setAttribute('data-tauri-drag-region', '');
  const titleApp = document.createElement('span');
  titleApp.className = 'rhwpp-title-app';
  titleApp.setAttribute('data-tauri-drag-region', '');
  title.append(titleName, titlePath, titleApp);

  const right = document.createElement('div');
  right.className = 'rhwpp-caption';
  const help = captionButton('minimize', '제품 정보');
  help.className = 'rhwpp-caption-btn rhwpp-caption-help';
  help.innerHTML = '<span aria-hidden="true">?</span>';
  help.addEventListener('click', () => studio.execute('file:about'));
  right.append(help);

  if (isTauri()) {
    const win = getCurrentWindow();
    const minimize = captionButton('minimize', '최소화');
    const maximize = captionButton('maximize', '최대화');
    const close = captionButton('close', '닫기');
    minimize.addEventListener('click', () => void win.minimize());
    maximize.addEventListener('click', () => void win.toggleMaximize());
    close.addEventListener('click', () => void win.close());
    right.append(minimize, maximize, close);

    const syncMaximized = async () => {
      const maximized = await win.isMaximized().catch(() => false);
      maximize.innerHTML = maximized ? CAPTION_ICONS.restore : CAPTION_ICONS.maximize;
      maximize.title = maximized ? '이전 크기로' : '최대화';
      document.documentElement.classList.toggle('rhwpp-maximized', maximized);
    };
    void syncMaximized();
    void win.onResized(() => void syncMaximized());
    void win.onFocusChanged(({ payload }) => {
      document.documentElement.classList.toggle('rhwpp-window-inactive', !payload);
    });
  } else {
    document.documentElement.classList.add('rhwpp-browser-preview');
  }

  bar.append(icon, qat, title, right);
  root.prepend(bar);

  onTitleChange((info) => {
    titleName.textContent = info.fileName ? `${info.dirty ? '*' : ''}${info.fileName}` : '';
    titlePath.textContent = info.directory ? ` [${info.directory}]` : '';
    titleApp.textContent = info.fileName ? ' - rhwpp' : 'rhwpp';
    title.title = info.text;
  });

  // 빠른 실행 도구 활성 상태(되돌리기/다시 실행 등)를 스튜디오 상태에 맞춘다.
  const syncQuickAccess = () => {
    for (const el of qat.querySelectorAll<HTMLButtonElement>('[data-qat-cmd]')) {
      el.disabled = !studio.isEnabled(el.dataset.qatCmd!);
    }
  };
  void studio.whenStudioReady().then(() => {
    studio.on('command-state-changed', syncQuickAccess);
    studio.on('document-swapped', syncQuickAccess);
    studio.on('document-dirty-changed', syncQuickAccess);
    syncQuickAccess();
  });
}
