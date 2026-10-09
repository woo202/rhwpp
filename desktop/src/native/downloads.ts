/**
 * `<a download>` 내려받기를 Windows 저장 대화상자로 바꾼다.
 *
 * 스튜디오는 HTML/Word(.doc) 내보내기, 저장 폴백 등을 브라우저 내려받기로 처리한다.
 * WebView2 기본 동작(내려받기 폴더에 조용히 저장)은 데스크톱 앱에 어울리지 않으므로
 * 사용자가 위치와 이름을 고르게 한다.
 */
import { mimeTypeFor } from '../util';
import { dialogSave, writeFile, type DialogFilter } from './ipc';
import { notify } from '../ui/notify';

const FILTER_NAMES: Record<string, string> = {
  hwp: 'HWP 문서',
  hwpx: 'HWPX 문서',
  hml: 'HML 문서',
  html: 'HTML 문서',
  htm: 'HTML 문서',
  doc: 'Word 문서',
  pdf: 'PDF 문서',
  png: 'PNG 그림',
  svg: 'SVG 그림',
  txt: '텍스트 문서',
  json: 'JSON',
};

function filtersFor(fileName: string): DialogFilter[] {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  const filters: DialogFilter[] = [];
  if (ext) filters.push({ name: `${FILTER_NAMES[ext] ?? ext.toUpperCase()} (*.${ext})`, extensions: [ext] });
  filters.push({ name: '모든 파일', extensions: ['*'] });
  return filters;
}

export async function saveBlobWithDialog(blob: Blob | Promise<Blob>, suggestedName: string): Promise<string | null> {
  const picked = await dialogSave({ filters: filtersFor(suggestedName), suggestedName, title: '내보내기' });
  if (!picked) return null;
  const bytes = new Uint8Array(await (await blob).arrayBuffer());
  await writeFile(picked.path, bytes);
  notify(`저장했습니다: ${picked.path}`);
  return picked.path;
}

function isInterceptable(anchor: HTMLAnchorElement): boolean {
  if (!anchor.hasAttribute('download')) return false;
  return anchor.href.startsWith('blob:') || anchor.href.startsWith('data:');
}

function interceptAnchor(anchor: HTMLAnchorElement): void {
  const name = anchor.download || 'document';
  // 스튜디오는 클릭 1초 뒤 blob URL 을 해제하므로 대화상자를 띄우기 전에 먼저 읽는다.
  const blob = fetch(anchor.href).then((response) => response.blob())
    .then((data) => (data.type ? data : new Blob([data], { type: mimeTypeFor(name) })));
  blob.catch(() => undefined);
  void saveBlobWithDialog(blob, name).catch((error) => {
    notify(`내보내기에 실패했습니다.\n${error instanceof Error ? error.message : String(error)}`, true);
  });
}

export function installDownloadInterceptor(): void {
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function patchedClick(this: HTMLAnchorElement) {
    if (isInterceptable(this)) {
      interceptAnchor(this);
      return;
    }
    originalClick.call(this);
  };
  // DOM 에 붙은 링크를 사용자가 직접 누르는 경우.
  document.addEventListener('click', (event) => {
    const anchor = (event.target as Element | null)?.closest?.('a[download]') as HTMLAnchorElement | null;
    if (!anchor || !isInterceptable(anchor)) return;
    event.preventDefault();
    interceptAnchor(anchor);
  }, true);
}
