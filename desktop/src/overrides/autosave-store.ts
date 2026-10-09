/**
 * 자동 저장 저장소 래퍼 (빌드 시 `@/recovery/autosave-store` 를 이 모듈로 바꿔 끼운다).
 *
 * 복구본은 모든 창이 같은 저장소를 쓴다. 스튜디오는 시작할 때 복구본이 있으면 복구를
 * 묻는데, 나중에 연 창이 다른 창에서 편집 중인 문서의 복구본을 묻지 않도록 프로그램을 처음
 * 켤 때 뜨는 첫 창(main)에서만 복구 후보를 보여 준다.
 */
export * from '@/recovery/autosave-store';
import { listAutosaveDrafts as listOriginal, type AutosaveDraft } from '@/recovery/autosave-store';

function isStartupWindow(): boolean {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
  }).__TAURI_INTERNALS__;
  const label = internals?.metadata?.currentWindow?.label;
  return label === undefined || label === 'main';
}

export async function listAutosaveDrafts(): Promise<AutosaveDraft[]> {
  if (!isStartupWindow()) return [];
  return listOriginal();
}
