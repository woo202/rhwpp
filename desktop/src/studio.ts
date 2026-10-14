/**
 * 업스트림 스튜디오와의 접점.
 *
 * 1순위는 빌드 시 main.ts 끝에 주입한 `window.__rhwppInternals`(커맨드 서비스·WASM 브리지·
 * 이벤트 버스), 2순위는 스튜디오가 공식으로 노출하는 `window.rhwpStudio.automation`.
 * 업스트림이 내부 이름을 바꿔 1순위가 사라져도 공개 API 로 핵심 기능이 동작하게 한다.
 */
import type { CommandServices } from '@/command/types';
import type { EventBus } from '@/core/event-bus';
import type { FileSystemFileHandleLike } from '@/command/file-system-access';
import { confirmSaveBeforeReplacingDocument, saveCurrentDocument } from '@/command/commands/file';
import { showUnsavedChangesDialog } from '@/ui/unsaved-changes-dialog';

interface StudioInternals {
  wasm?: {
    fileName: string;
    pageCount: number;
    currentFileHandle: FileSystemFileHandleLike | null;
    hasLoadedDocument(): boolean;
    isNewDocument?: boolean;
  };
  eventBus?: EventBus;
  documentState?: { isDirty(): boolean };
  commandServices?: CommandServices;
  autosaveManager?: { discardCurrentDraft(reason?: string): Promise<void> };
}

interface StudioAutomationLike {
  execute(id: string, params?: Record<string, unknown>, options?: { allowDialog?: boolean }): { ok: boolean };
  isEnabled(id: string): boolean;
  getContext(): { hasDocument: boolean; isDirty: boolean };
  registerCommand(def: unknown): void;
  addMenuItem(spec: { menuId: string; commandId: string; position?: 'top' | 'bottom' }): void;
}

function internals(): StudioInternals {
  return ((window as unknown as { __rhwppInternals?: StudioInternals }).__rhwppInternals) ?? {};
}

export function automation(): StudioAutomationLike | null {
  return (window as unknown as { rhwpStudio?: { automation?: StudioAutomationLike } }).rhwpStudio?.automation ?? null;
}

/** 스튜디오 모듈이 실행돼 공개 API 가 준비되면 resolve. */
export function whenStudioReady(): Promise<void> {
  if (automation()) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (automation()) {
        window.removeEventListener('rhwpp:studio-ready', check);
        resolve();
      }
    };
    window.addEventListener('rhwpp:studio-ready', check);
    const timer = window.setInterval(() => {
      if (automation()) {
        window.clearInterval(timer);
        check();
      }
    }, 50);
  });
}

export function hasDocument(): boolean {
  const wasm = internals().wasm;
  if (wasm) return wasm.pageCount > 0;
  return automation()?.getContext().hasDocument ?? false;
}

export function isDirty(): boolean {
  const state = internals().documentState;
  if (state) return state.isDirty();
  return automation()?.getContext().isDirty ?? false;
}

export function fileName(): string {
  return internals().wasm?.fileName ?? '';
}

/** 현재 문서의 디스크 경로(새 문서이거나 내려받기로 저장했으면 null). */
export function filePath(): string | null {
  const handle = internals().wasm?.currentFileHandle as { path?: unknown } | null | undefined;
  return handle && typeof handle.path === 'string' ? handle.path : null;
}

/** 아직 손대지 않은 빈 새 문서인가(다른 문서를 이 창에 열어도 되는가). */
export function isPristine(): boolean {
  if (!hasDocument()) return true;
  const wasm = internals().wasm;
  return !isDirty() && !filePath() && (wasm?.isNewDocument ?? false);
}

export function execute(id: string, params?: Record<string, unknown>): boolean {
  return automation()?.execute(id, params, { allowDialog: true }).ok ?? false;
}

export function isEnabled(id: string): boolean {
  return automation()?.isEnabled(id) ?? false;
}

export function on(event: string, handler: (...args: unknown[]) => void): () => void {
  return internals().eventBus?.on(event, handler) ?? (() => undefined);
}

/**
 * 창을 닫거나 문서를 바꾸기 전 저장 확인. 계속해도 되면 true.
 * 스튜디오 자신의 "저장하시겠습니까?" 대화상자와 저장 흐름을 그대로 쓴다.
 */
export async function confirmDiscardOrSave(): Promise<boolean> {
  if (!hasDocument() || !isDirty()) return true;
  const services = internals().commandServices;
  if (services) return confirmSaveBeforeReplacingDocument(services);

  // 폴백: 공개 API 만으로 처리한다.
  const choice = await showUnsavedChangesDialog({ fileName: fileName(), canSave: true });
  if (choice === 'cancel') return false;
  if (choice === 'discard') return true;
  execute('file:save');
  return waitUntilClean(60_000);
}

/** 창을 정상적으로 닫을 때 이 문서의 자동 저장 복구본을 지운다(한글과 같은 동작). */
export async function discardRecoveryDraft(): Promise<void> {
  try {
    await internals().autosaveManager?.discardCurrentDraft('window-close');
  } catch (error) {
    console.warn('[rhwpp] 복구본 정리 실패', error);
  }
}

/** 저장(Ctrl+S 와 같음). 결과를 기다릴 수 있다. */
export async function save(): Promise<boolean> {
  const services = internals().commandServices;
  if (services) return (await saveCurrentDocument(services)) === 'saved';
  execute('file:save');
  return waitUntilClean(60_000);
}

function waitUntilClean(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (!isDirty()) {
        window.clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        window.clearInterval(timer);
        resolve(false);
      }
    }, 200);
  });
}
