/**
 * 시작 문서(실행 인자·다른 창에서 넘긴 문서)의 처리 완료 신호.
 *
 * 스튜디오는 시작할 때 "복구본 확인 → 문서가 없으면 빈 문서 만들기"를 돈다. 시작 문서가
 * 열리기 전에 빈 문서가 먼저 만들어지면 화면이 깜빡이고 초기화가 겹치므로, 복구본 목록을
 * 돌려주기 전에 이 신호를 기다린다(overrides/autosave-store.ts).
 */
let resolveSettled!: () => void;

export const launchSettled: Promise<void> = new Promise((resolve) => {
  resolveSettled = resolve;
});

export function markLaunchSettled(): void {
  resolveSettled();
}
