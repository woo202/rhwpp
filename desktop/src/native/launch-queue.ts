/**
 * PWA `window.launchQueue` 폴리필.
 *
 * 스튜디오는 초기화 끝에 `launchQueue.setConsumer()` 로 "운영체제가 넘겨준 파일"을 받는다.
 * 데스크톱에서는 실행 인자/다른 인스턴스/끌어다 놓기로 받은 경로를 같은 통로로 넣어,
 * 스튜디오 자신의 열기 흐름(저장 안 된 변경 확인 포함)을 그대로 탄다.
 */
import type { FileHandlingLaunchParamsLike } from '@/command/pwa-file-handling';
import { NativeFileHandle } from './file-handle';

type Consumer = (params: FileHandlingLaunchParamsLike) => void;

class NativeLaunchQueue {
  private consumer: Consumer | null = null;
  private readonly pending: NativeFileHandle[][] = [];

  setConsumer(consumer: Consumer): void {
    this.consumer = consumer;
    while (this.pending.length > 0) {
      consumer({ files: this.pending.shift()! });
    }
  }

  enqueue(handles: NativeFileHandle[]): void {
    if (handles.length === 0) return;
    if (this.consumer) this.consumer({ files: handles });
    else this.pending.push(handles);
  }

  get ready(): boolean {
    return this.consumer !== null;
  }
}

export const launchQueue = new NativeLaunchQueue();

export function installLaunchQueue(target: Window = window): void {
  Object.defineProperty(target, 'launchQueue', {
    configurable: true,
    value: launchQueue,
  });
}

/** 이 창에서 문서 하나를 연다(스튜디오가 저장 확인 후 교체). */
export function openInThisWindow(path: string, name?: string): void {
  launchQueue.enqueue([new NativeFileHandle(path, name)]);
}
