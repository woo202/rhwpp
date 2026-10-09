/**
 * Rust 셸(src-tauri)의 명령을 감싼다. Tauri 밖(일반 브라우저 미리보기)에서는
 * `isTauri()` 가 false 이고 호출부가 기능을 끈다.
 */
import { invoke } from '@tauri-apps/api/core';

export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface PickedFile {
  path: string;
  name: string;
}

export interface FileStat {
  path: string;
  name: string;
  size: number;
  modifiedMs: number;
  readonly: boolean;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function dialogOpen(options: {
  filters: DialogFilter[];
  multiple?: boolean;
  title?: string;
}): Promise<PickedFile[]> {
  return invoke('dialog_open', {
    filters: options.filters,
    multiple: options.multiple ?? false,
    title: options.title ?? null,
  });
}

export function dialogSave(options: {
  filters: DialogFilter[];
  suggestedName?: string;
  title?: string;
}): Promise<PickedFile | null> {
  return invoke('dialog_save', {
    filters: options.filters,
    suggestedName: options.suggestedName ?? null,
    title: options.title ?? null,
  });
}

export async function readFile(path: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>('read_file', { path });
  return new Uint8Array(buffer);
}

export function writeFile(path: string, bytes: Uint8Array): Promise<FileStat> {
  return invoke('write_file', bytes, {
    headers: { 'x-rhwpp-path': encodeURIComponent(path) },
  });
}

export function fileStat(path: string): Promise<FileStat> {
  return invoke('file_stat', { path });
}

export function revealInFolder(path: string): Promise<void> {
  return invoke('reveal_in_folder', { path });
}

export function openExternal(url: string): Promise<void> {
  return invoke('open_external', { url });
}

export function takeLaunchFiles(): Promise<PickedFile[]> {
  return invoke('take_launch_files');
}

export function openWindow(paths: string[] = []): Promise<string> {
  return invoke('open_window', { paths });
}

export function requestQuit(): Promise<void> {
  return invoke('request_quit');
}

export function setWindowDocument(path: string | null): Promise<void> {
  return invoke('set_window_document', { path });
}

/** 이 문서를 편집 중인 다른 창이 있으면 그 창을 앞으로 가져오고 라벨을 돌려준다. */
export function focusWindowForDocument(path: string): Promise<string | null> {
  return invoke('focus_window_for_document', { path });
}

export function destroyWindow(): Promise<void> {
  return invoke('destroy_window');
}

export function appDataDir(): Promise<string> {
  return invoke('app_data_dir');
}

export { baseName, dirName } from '../util';
