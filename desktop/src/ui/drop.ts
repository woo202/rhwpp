/**
 * 탐색기에서 끌어다 놓기.
 *
 * Tauri(WebView2)는 네이티브 끌어다 놓기를 가로채 실제 경로를 준다.
 *  - HWP/HWPX/HML: 지금 창이 빈 새 문서면 여기서, 아니면 새 창에서 연다(한글의 새 탭처럼).
 *  - 그림: 스튜디오의 "그림 끌어다 넣기"(놓은 자리에 삽입)를 그대로 쓰도록 같은 DOM drop
 *    이벤트를 만들어 문서 영역에 보낸다.
 */
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { isSupportedDocumentFileName } from '@/command/file-system-access';
import { baseName, focusWindowForDocument, openWindow, readFile } from '../native/ipc';
import { mimeTypeFor, samePath } from '../util';
import { openInThisWindow } from '../native/launch-queue';
import * as studio from '../studio';
import { notify } from './notify';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];

function isImage(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTS.some((ext) => lower.endsWith(ext));
}

function scrollContainer(): HTMLElement | null {
  return document.getElementById('scroll-container');
}

async function insertImage(path: string, clientX: number, clientY: number): Promise<void> {
  const target = scrollContainer();
  if (!target) return;
  const name = baseName(path);
  const bytes = await readFile(path);
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes as BlobPart], name, { type: mimeTypeFor(name) }));
  target.dispatchEvent(new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    dataTransfer: transfer,
  }));
}

export async function openDocuments(paths: string[]): Promise<void> {
  const candidates = paths.filter((p) => isSupportedDocumentFileName(baseName(p)));
  const docs: string[] = [];
  for (const path of candidates) {
    // 이미 다른 창에서 편집 중이면 그 창으로 전환한다.
    if (studio.filePath() && samePath(studio.filePath()!, path)) continue;
    if (await focusWindowForDocument(path).catch(() => null)) continue;
    docs.push(path);
  }
  if (docs.length === 0) return;
  let rest = docs;
  if (studio.isPristine()) {
    openInThisWindow(docs[0]);
    rest = docs.slice(1);
  }
  for (const path of rest) {
    await openWindow([path]);
  }
}

export function installDrop(): void {
  void getCurrentWebview().onDragDropEvent(async (event) => {
    const container = scrollContainer();
    const payload = event.payload;
    if (payload.type === 'enter' || payload.type === 'over') {
      container?.classList.add('drag-over');
      return;
    }
    container?.classList.remove('drag-over');
    if (payload.type !== 'drop') return;

    const scale = window.devicePixelRatio || 1;
    const clientX = payload.position.x / scale;
    const clientY = payload.position.y / scale;
    const docs = payload.paths.filter((p) => isSupportedDocumentFileName(baseName(p)));
    const images = payload.paths.filter(isImage);
    try {
      if (docs.length > 0) {
        await openDocuments(docs);
      } else if (images.length > 0) {
        await insertImage(images[0], clientX, clientY);
      } else if (payload.paths.length > 0) {
        notify('HWP/HWPX/HML 문서 또는 그림 파일만 끌어다 놓을 수 있습니다.', true);
      }
    } catch (error) {
      notify(`파일을 열지 못했습니다.\n${error instanceof Error ? error.message : String(error)}`, true);
    }
  });
}
