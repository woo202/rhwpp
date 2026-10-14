/**
 * `window.showOpenFilePicker` / `window.showSaveFilePicker` 를 Windows 기본 파일 대화상자로
 * 대체한다. 스튜디오는 이 API 가 있으면 그것을 쓰고, 반환된 핸들로 읽고 쓴다.
 */
import type { FilePickerType } from '@/command/save-format';
import { NativeFileHandle } from './file-handle';
import { filtersFromTypes } from '../util';
import { dialogOpen, dialogSave, focusWindowForDocument } from './ipc';

export { filtersFromTypes };

interface OpenPickerOptions {
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
  types?: FilePickerType[];
}

interface SavePickerOptions {
  excludeAcceptAllOption?: boolean;
  suggestedName?: string;
  types?: FilePickerType[];
}

function abortError(): DOMException {
  return new DOMException('사용자가 대화상자를 취소했습니다.', 'AbortError');
}

export async function showOpenFilePicker(options: OpenPickerOptions = {}): Promise<NativeFileHandle[]> {
  const picked = await dialogOpen({
    filters: filtersFromTypes(options.types, !options.excludeAcceptAllOption),
    multiple: options.multiple ?? false,
    title: '불러오기',
  });
  if (picked.length === 0) throw abortError();
  // 이미 다른 창에서 편집 중인 문서면 그 창으로 전환한다(같은 파일을 두 곳에서 고치지 않게).
  if (picked.length === 1 && await focusWindowForDocument(picked[0].path).catch(() => null)) {
    throw abortError();
  }
  return picked.map((file) => new NativeFileHandle(file.path, file.name));
}

export async function showSaveFilePicker(options: SavePickerOptions = {}): Promise<NativeFileHandle> {
  const picked = await dialogSave({
    filters: filtersFromTypes(options.types, !options.excludeAcceptAllOption),
    suggestedName: options.suggestedName,
    title: '다른 이름으로 저장하기',
  });
  if (!picked) throw abortError();
  return new NativeFileHandle(picked.path, picked.name);
}

export function installNativePickers(target: Window = window): void {
  Object.defineProperty(target, 'showOpenFilePicker', {
    configurable: true,
    writable: true,
    value: showOpenFilePicker,
  });
  Object.defineProperty(target, 'showSaveFilePicker', {
    configurable: true,
    writable: true,
    value: showSaveFilePicker,
  });
}
