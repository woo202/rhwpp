/**
 * 최근 문서 저장소 래퍼 (빌드 시 `@/recent/recent-store` 를 이 모듈로 바꿔 끼운다).
 *
 * 원본은 핸들을 IndexedDB 에 structured clone 으로 저장한다. 네이티브 핸들은 경로만 남은
 * 평범한 객체로 저장되므로, 꺼낼 때 다시 `NativeFileHandle` 로 되살려 재열기가 동작하게 한다.
 */
export * from '@/recent/recent-store';
import { listRecentDocs as listOriginal, type RecentDoc } from '@/recent/recent-store';
import { reviveNativeHandle } from '../native/file-handle';

export async function listRecentDocs(): Promise<RecentDoc[]> {
  const rows = await listOriginal();
  return rows.map((row) => (row.handle ? { ...row, handle: reviveNativeHandle(row.handle) } : row));
}
