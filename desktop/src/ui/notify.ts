import { showToast } from '@/ui/toast';

/** 우상단 알림. 오류는 사용자가 닫을 때까지 남긴다. */
export function notify(message: string, isError = false): void {
  showToast(isError
    ? { message, durationMs: 0, confirmLabel: '확인' }
    : { message, durationMs: 3500 });
}
