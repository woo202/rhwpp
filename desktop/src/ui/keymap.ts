/**
 * 데스크톱 단축키.
 *
 * 1) 한글의 파일·창 단축키(Alt+O/S/V/P/X, Ctrl+F4 …)를 더한다. 웹에서는 브라우저와
 *    겹쳐 쓰지 못하던 한글 정렬 단축키(Ctrl+Shift+L/C/R/M/T)도 되살린다.
 * 2) 새로 고침(F5)·뒤로 가기(Alt+←) 같은 브라우저 단축키를 막는다. 데스크톱 앱에서
 *    누르면 편집 중인 문서가 사라진다.
 */
import * as studio from '../studio';
import { isBrowserReservedKey, matchesShortcut } from '../util';

export interface DesktopShortcut {
  key: string;
  /** 물리 키(한글 입력 상태에서 key 가 'ㅐ' 등으로 바뀌어도 맞춘다) */
  code?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  run: () => void;
  /** 대화상자가 떠 있어도 실행할지 */
  global?: boolean;
}

let shortcuts: DesktopShortcut[] = [];

export function setDesktopShortcuts(list: DesktopShortcut[]): void {
  shortcuts = list;
}

const cmd = (id: string) => () => { studio.execute(id); };

/** 한글 단축키 중 스튜디오에 없거나 웹에서 다른 키로 옮겨 둔 것. */
export function hangulShortcuts(actions: {
  exit: () => void;
  closeDocument: () => void;
  newWindow: () => void;
}): DesktopShortcut[] {
  return [
    { key: 'o', code: 'KeyO', alt: true, run: cmd('file:open') },
    { key: 's', code: 'KeyS', alt: true, run: cmd('file:save') },
    { key: 'v', code: 'KeyV', alt: true, run: cmd('file:save-as') },
    { key: 'p', code: 'KeyP', alt: true, run: cmd('file:print') },
    { key: 'x', code: 'KeyX', alt: true, run: actions.exit, global: true },
    { key: 'f4', ctrl: true, run: actions.closeDocument, global: true },
    { key: 'n', code: 'KeyN', ctrl: true, alt: true, run: actions.newWindow },
    { key: 'f6', run: cmd('format:style-dialog') },
    { key: 'l', code: 'KeyL', ctrl: true, shift: true, run: cmd('format:align-left') },
    { key: 'c', code: 'KeyC', ctrl: true, shift: true, run: cmd('format:align-center') },
    { key: 'r', code: 'KeyR', ctrl: true, shift: true, run: cmd('format:align-right') },
    { key: 'm', code: 'KeyM', ctrl: true, shift: true, run: cmd('format:align-justify') },
    { key: 't', code: 'KeyT', ctrl: true, shift: true, run: cmd('format:align-distribute') },
  ];
}

function modalOpen(): boolean {
  return document.querySelector('.modal-overlay') !== null;
}

export function installKeymap(): void {
  window.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    for (const shortcut of shortcuts) {
      if (!matchesShortcut(e, shortcut)) continue;
      if (!shortcut.global && modalOpen()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      shortcut.run();
      return;
    }
    if (isBrowserReservedKey(e, import.meta.env.DEV)) {
      // 기본 동작만 막고 전파는 둔다. 스튜디오가 같은 키를 자기 기능에 쓸 수 있다.
      e.preventDefault();
    }
  }, true);

  // 마우스 뒤로/앞으로 단추로 페이지가 바뀌지 않게 한다.
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  }, true);
}
