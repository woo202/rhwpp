/**
 * 네이티브 경로 기반 파일 핸들.
 *
 * 업스트림 스튜디오는 File System Access API 의 `FileSystemFileHandle` 모양
 * (`FileSystemFileHandleLike`)만 요구한다. 이 클래스가 같은 모양을 Rust 셸의 파일 입출력으로
 * 구현하므로 스튜디오의 열기/저장/다른 이름으로 저장/최근 문서 흐름이 수정 없이 실제 경로로
 * 동작한다.
 *
 * 메서드는 프로토타입에만 두고 인스턴스에는 직렬화 가능한 값(kind/name/path)만 둔다.
 * IndexedDB(최근 문서)에 structured clone 으로 저장되면 평범한 객체가 되는데,
 * `reviveNativeHandle` 로 다시 핸들로 되살린다.
 */
import type {
  FileSystemFileHandleLike,
  FileSystemPermissionState,
  FileSystemWritableFileStreamLike,
} from '@/command/file-system-access';
import { mimeTypeFor, nativeHandleRecord, resolvePrefetched, samePath } from '../util';
import { baseName, readFile, writeFile } from './ipc';
import { notify } from '../ui/notify';

export { mimeTypeFor, samePath };

class NativeWritable implements FileSystemWritableFileStreamLike {
  private readonly chunks: Blob[] = [];

  constructor(private readonly handle: NativeFileHandle) {}

  async write(data: Blob): Promise<void> {
    this.chunks.push(data instanceof Blob ? data : new Blob([data as BlobPart]));
  }

  async close(): Promise<void> {
    const bytes = new Uint8Array(await new Blob(this.chunks).arrayBuffer());
    this.chunks.length = 0;
    try {
      await writeFile(this.handle.path, bytes);
    } catch (error) {
      // 스튜디오는 AbortError 가 아닌 오류를 "내려받기로 저장" 흐름으로 넘기고 곧바로 문서를
      // 저장된 것으로 표시한다. 그러면 창을 닫을 때 편집 내용이 사라질 수 있으므로, 원인을
      // 알린 뒤 취소(AbortError)로 돌려 문서를 '수정됨' 상태로 남긴다.
      const reason = error instanceof Error ? error.message : String(error);
      notify(`저장하지 못했습니다.\n${reason}\n다른 이름으로 저장(Alt+V)으로 다른 위치에 저장하세요.`, true);
      throw new DOMException(`저장 실패: ${reason}`, 'AbortError');
    }
    this.handle.forgetCachedBytes();
    window.dispatchEvent(new CustomEvent('rhwpp:file-written', { detail: { path: this.handle.path } }));
  }
}

/** `getFile()` 이 끝날 때 보내는 창 이벤트. detail: { path } */
export const FILE_READ_EVENT = 'rhwpp:file-read';

export class NativeFileHandle implements FileSystemFileHandleLike {
  readonly kind = 'file' as const;
  readonly name: string;
  readonly path: string;
  /** structured clone 뒤에도 남는 표식. */
  readonly __rhwppNative = true;

  constructor(path: string, name?: string) {
    this.path = path;
    this.name = name ?? baseName(path);
  }

  async getFile(): Promise<File> {
    try {
      // 시작 문서는 미리 읽는 중일 수 있다(느린 PC). 끝날 때까지 기다리고, 실패했으면 다시 읽는다.
      const bytes = await resolvePrefetched(takePrefetched(this.path), () => readFile(this.path));
      return new File([bytes as BlobPart], this.name, { type: mimeTypeFor(this.name) });
    } finally {
      // 성공·실패와 관계없이 읽기가 끝났음을 알린다(boot.ts 가 시작 문서 대기 시간을 여기서부터 잰다).
      window.dispatchEvent(new CustomEvent(FILE_READ_EVENT, { detail: { path: this.path } }));
    }
  }

  async createWritable(): Promise<FileSystemWritableFileStreamLike> {
    return new NativeWritable(this);
  }

  async isSameEntry(other: FileSystemFileHandleLike): Promise<boolean> {
    const otherPath = (other as Partial<NativeFileHandle>)?.path;
    return typeof otherPath === 'string' && samePath(otherPath, this.path);
  }

  async queryPermission(): Promise<FileSystemPermissionState> {
    return 'granted';
  }

  async requestPermission(): Promise<FileSystemPermissionState> {
    return 'granted';
  }

  forgetCachedBytes(): void {
    prefetched.delete(this.path);
  }
}

export function isNativeHandle(value: unknown): value is NativeFileHandle {
  return value instanceof NativeFileHandle;
}

/** IndexedDB 에서 꺼낸 평범한 객체를 핸들로 되살린다. 해당하지 않으면 그대로 돌려준다. */
export function reviveNativeHandle<T>(value: T): T | NativeFileHandle {
  if (value instanceof NativeFileHandle) return value;
  const record = nativeHandleRecord(value);
  return record ? new NativeFileHandle(record.path, record.name) : value;
}

// ── 시작 시 미리 읽어 둔 바이트 ───────────────────────────────
// 실행 인자로 받은 문서는 스튜디오 초기화와 병렬로 읽어 두고, 첫 getFile() 에서 쓴다.
const prefetched = new Map<string, Promise<Uint8Array> | Uint8Array>();

export function prefetch(path: string): void {
  if (prefetched.has(path)) return;
  const pending = readFile(path).then((bytes) => {
    if (prefetched.get(path) === pending) prefetched.set(path, bytes);
    return bytes;
  });
  pending.catch(() => prefetched.delete(path));
  prefetched.set(path, pending);
}

function takePrefetched(path: string): Promise<Uint8Array> | Uint8Array | undefined {
  const value = prefetched.get(path);
  prefetched.delete(path);
  return value;
}
