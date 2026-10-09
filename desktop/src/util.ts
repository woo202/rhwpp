/**
 * 의존성 없는 순수 함수 모음. Node 테스트(desktop/tests)가 그대로 불러 검증한다.
 * 이 파일은 다른 모듈을 import 하지 않는다.
 */

export interface DialogFilterLike {
  name: string;
  extensions: string[];
}

export interface FilePickerTypeLike {
  description: string;
  accept: Record<string, string[]>;
}

/** 경로에서 파일 이름만. Windows/POSIX 구분자를 모두 처리한다. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 경로에서 폴더 부분(끝 구분자 포함). */
export function dirName(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return index >= 0 ? path.slice(0, index + 1) : '';
}

/** 경로 비교(Windows 는 대소문자·구분자·끝 구분자 무시). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

const MIME_BY_EXT: Record<string, string> = {
  hwp: 'application/x-hwp',
  hwpx: 'application/hwp+zip',
  hml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  doc: 'application/msword',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export function mimeTypeFor(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export const ALL_FILES_FILTER: DialogFilterLike = { name: '모든 파일', extensions: ['*'] };

/** File System Access 의 accept 표기를 Windows 대화상자 필터로 바꾼다. */
export function filtersFromTypes(types: FilePickerTypeLike[] | undefined, includeAll: boolean): DialogFilterLike[] {
  const filters: DialogFilterLike[] = [];
  for (const type of types ?? []) {
    const extensions = [...new Set(
      Object.values(type.accept ?? {})
        .flat()
        .map((ext) => ext.replace(/^\./, '').toLowerCase())
        .filter(Boolean),
    )];
    if (extensions.length === 0) continue;
    const label = `${type.description} (${extensions.map((e) => `*.${e}`).join(';')})`;
    filters.push({ name: label, extensions });
  }
  if (includeAll || filters.length === 0) filters.push(ALL_FILES_FILTER);
  return filters;
}

/** IndexedDB 에서 꺼낸 값이 네이티브 핸들의 흔적이면 경로/이름을 돌려준다. */
export function nativeHandleRecord(value: unknown): { path: string; name?: string } | null {
  const record = value as { __rhwppNative?: unknown; path?: unknown; name?: unknown } | null;
  if (!record || typeof record !== 'object') return null;
  if (record.__rhwppNative !== true || typeof record.path !== 'string' || record.path === '') return null;
  return { path: record.path, name: typeof record.name === 'string' ? record.name : undefined };
}

export interface DocumentTitleParts {
  fileName: string;
  directory: string;
  dirty: boolean;
  text: string;
}

/** 제목 표시줄 문자열: "*문서.hwp [C:\폴더\] - rhwpp" */
export function documentTitle(fileName: string, path: string | null, dirty: boolean, appName = 'rhwpp'): DocumentTitleParts {
  const directory = path ? dirName(path) : '';
  const parts: string[] = [];
  if (fileName) parts.push(`${dirty ? '*' : ''}${fileName}${directory ? ` [${directory}]` : ''}`);
  parts.push(appName);
  return { fileName, directory, dirty: dirty && !!fileName, text: parts.join(' - ') };
}

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey?: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface ShortcutSpec {
  key: string;
  code?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export function matchesShortcut(e: KeyLike, s: ShortcutSpec): boolean {
  const ctrl = e.ctrlKey || !!e.metaKey;
  if ((s.ctrl ?? false) !== ctrl) return false;
  if ((s.alt ?? false) !== e.altKey) return false;
  if ((s.shift ?? false) !== e.shiftKey) return false;
  return e.key.toLowerCase() === s.key || (!!s.code && e.code === s.code);
}

/** 데스크톱 앱에서 막아야 하는 브라우저 단축키(새로 고침, 뒤로 가기 등). */
export function isBrowserReservedKey(e: KeyLike, dev = false): boolean {
  const key = e.key.toLowerCase();
  const ctrl = e.ctrlKey || !!e.metaKey;
  if (key === 'f5' || key === 'browserrefresh' || key === 'browserback' || key === 'browserforward') return true;
  if (ctrl && (key === 'r' || e.code === 'KeyR')) return true;
  if (e.altKey && (key === 'arrowleft' || key === 'arrowright') && !ctrl && !e.shiftKey) return true;
  if (ctrl && !e.shiftKey && !e.altKey && ['j', 'h'].includes(key)) return true;
  if (key === 'f7' && e.shiftKey) return true;
  if (!dev && key === 'f12') return true;
  if (!dev && ctrl && e.shiftKey && (key === 'i' || key === 'j')) return true;
  return false;
}

/** 창 제목("*문서.hwp [C:\폴더\] - rhwpp")에서 문서 탭 이름을 뽑는다. */
export function tabLabelFromTitle(title: string, appName = 'rhwpp'): { name: string; dirty: boolean } {
  let text = title.trim();
  const suffix = ` - ${appName}`;
  if (text.endsWith(suffix)) text = text.slice(0, -suffix.length);
  else if (text === appName) text = '';
  text = text.replace(/\s\[[^\]]*\]$/, '');
  const dirty = text.startsWith('*');
  if (dirty) text = text.slice(1);
  return { name: text || '빈 문서', dirty };
}
