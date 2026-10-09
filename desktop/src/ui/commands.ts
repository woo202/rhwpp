/**
 * 데스크톱 전용 명령. 스튜디오의 확장 명령(`ext:` 접두사) 등록 API 로 넣으므로 메뉴·리본·
 * 명령 찾기(Ctrl+/)에서 내장 명령과 똑같이 실행되고 활성/비활성도 같은 규칙을 탄다.
 */
import type { CommandRegistry } from '@/command/registry';
import type { CommandDispatcher } from '@/command/dispatcher';
import { CommandPalette } from '@/ui/command-palette';
import { ModalDialog } from '@/ui/dialog';
import { isTauri, openWindow, requestQuit, revealInFolder, appDataDir } from '../native/ipc';
import * as studio from '../studio';
import { notify } from './notify';
import { closeThisWindow } from './window-lifecycle';


export function newWindow(): void {
  if (!isTauri()) {
    window.open(window.location.href, '_blank');
    return;
  }
  void openWindow([]).catch((error) => notify(`새 창을 열지 못했습니다.\n${error}`, true));
}

export function exitApp(): void {
  if (!isTauri()) {
    void closeThisWindow();
    return;
  }
  void requestQuit();
}

export function closeDocument(): void {
  void closeThisWindow();
}

function revealCurrentFile(): void {
  const path = studio.filePath();
  if (!path) {
    notify('저장된 파일이 아닙니다. 먼저 저장하세요.');
    return;
  }
  void revealInFolder(path).catch((error) => notify(`파일 위치를 열지 못했습니다.\n${error}`, true));
}

function openCommandPalette(): void {
  const internals = (window as unknown as {
    __rhwppInternals?: { registry?: CommandRegistry; dispatcher?: CommandDispatcher };
  }).__rhwppInternals;
  if (internals?.registry && internals.dispatcher) {
    new CommandPalette(internals.registry, internals.dispatcher).open();
  }
}

class DesktopAboutDialog extends ModalDialog {
  constructor(private readonly dataDir: string) {
    super('rhwpp 정보', 460);
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'rhwpp-about';
    const webview = navigator.userAgent.match(/Edg\/([\d.]+)/)?.[1]
      ?? navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '-';
    const rows: [string, string][] = [
      ['프로그램', `rhwpp ${__RHWPP_VERSION__}`],
      ['문서 엔진', `rhwp ${__RHWPP_UPSTREAM_VERSION__} (${__RHWPP_UPSTREAM_COMMIT__.slice(0, 12)})`],
      ['웹 엔진', `Microsoft Edge WebView2 ${webview}`],
      ['설정 폴더', this.dataDir || '-'],
    ];
    body.innerHTML = `
      <p class="rhwpp-about-lead">rhwp(Rust + WebAssembly) 엔진 기반의 Windows용 HWP/HWPX 워드프로세서입니다.</p>
      <table>${rows.map(([k, v]) => `<tr><th>${k}</th><td></td></tr>`).join('')}</table>
      <p class="rhwpp-about-note">rhwp © Edward Kim 및 기여자 · MIT 라이선스<br/>
      "한글", "HWP"는 (주)한글과컴퓨터의 상표이며, 이 프로그램은 한글과컴퓨터와 관련이 없습니다.</p>`;
    body.querySelectorAll('td').forEach((td, i) => { td.textContent = rows[i][1]; });
    return body;
  }

  protected onConfirm(): void {
    // 확인 = 닫기
  }
}

async function showDesktopAbout(): Promise<void> {
  const dir = isTauri() ? await appDataDir().catch(() => '') : '';
  new DesktopAboutDialog(dir).show();
}

export function registerDesktopCommands(): void {
  const automation = studio.automation();
  if (!automation) return;
  const defs = [
    { id: 'ext:rhwpp.new-window', label: '새 창', shortcutLabel: 'Ctrl+Alt+N', execute: newWindow },
    { id: 'ext:rhwpp.close', label: '문서 닫기', shortcutLabel: 'Ctrl+F4', execute: closeDocument },
    { id: 'ext:rhwpp.exit', label: '끝', shortcutLabel: 'Alt+X', execute: exitApp },
    {
      id: 'ext:rhwpp.reveal',
      label: '파일 위치 열기',
      canExecute: () => isTauri() && studio.filePath() !== null,
      execute: revealCurrentFile,
    },
    { id: 'ext:rhwpp.command-palette', label: '명령 찾기', shortcutLabel: 'Ctrl+/', execute: openCommandPalette },
    { id: 'ext:rhwpp.about', label: 'rhwpp 정보', opensDialog: true, execute: () => void showDesktopAbout() },
  ];
  for (const def of defs) automation.registerCommand(def);

  // 파일 메뉴(열림 상자)에도 넣는다: 새 창은 위, 닫기/끝은 아래.
  const place = (menuId: string, commandId: string, position: 'top' | 'bottom') => {
    try {
      automation.addMenuItem({ menuId, commandId, position });
    } catch (error) {
      console.warn('[rhwpp] 메뉴 항목 추가 실패', commandId, error);
    }
  };
  place('file', 'ext:rhwpp.new-window', 'top');
  place('file', 'ext:rhwpp.reveal', 'bottom');
  place('file', 'ext:rhwpp.close', 'bottom');
  place('file', 'ext:rhwpp.exit', 'bottom');
  place('tool', 'ext:rhwpp.command-palette', 'bottom');
  place('tool', 'ext:rhwpp.about', 'bottom');
}
