/**
 * 자동 업데이트 알림과 명령.
 *
 * 확인·받기·설치는 Rust 셸(updater.rs)이 한다. 새 버전을 받아 두면 창에 이벤트를 보내고,
 * 지금 앞에 있는 창 하나가 알림을 띄운다(여러 창에 겹쳐 뜨지 않게 셸이 한 번만 내준다).
 */
import { listen } from '@tauri-apps/api/event';
import { showToast } from '@/ui/toast';
import {
  isTauri,
  openExternal,
  updateCheck,
  updateInstallNow,
  updateSetAuto,
  updateStatus,
  updateTakeNotice,
  type UpdateStatus,
} from '../native/ipc';
import { notify } from './notify';

const UPDATE_EVENT = 'rhwpp://update';

function openReleasePage(status: UpdateStatus): void {
  void openExternal(`${status.releasesUrl}/latest`).catch((error) => notify(`페이지를 열지 못했습니다.\n${error}`, true));
}

function installNow(): void {
  void updateInstallNow().catch((error) => notify(`업데이트를 설치하지 못했습니다.\n${error}`, true));
}

/** 새 버전 알림. 결과가 "최신"이나 오류이면 수동 확인일 때만 알린다. */
function showStatus(status: UpdateStatus, manual: boolean): void {
  const latest = status.latest ?? '';
  switch (status.state) {
    case 'ready':
      if (status.kind === 'allUsers') {
        showToast({
          message: `rhwpp ${latest} 업데이트를 받았습니다.\n모든 사용자용 설치라 관리자 확인이 필요합니다.`,
          durationMs: 0,
          action: { label: '지금 업데이트', onClick: installNow },
          confirmLabel: '나중에',
        });
      } else {
        showToast({
          message: status.installsOnExit
            ? `rhwpp ${latest} 업데이트를 받았습니다.\n프로그램을 끝내면 자동으로 설치됩니다.`
            : `rhwpp ${latest} 업데이트를 받았습니다.\n'지금 다시 시작'을 누르면 설치합니다.`,
          durationMs: 0,
          action: { label: '지금 다시 시작', onClick: installNow },
          confirmLabel: '나중에',
        });
      }
      return;
    case 'available':
      showToast({
        message: status.kind === 'portable'
          ? `rhwpp ${latest} 새 버전이 나왔습니다.\n설치된 프로그램이 아니어서 직접 받아야 합니다.`
          : `rhwpp ${latest} 새 버전이 나왔지만 받지 못했습니다.${status.error ? `\n${status.error}` : ''}`,
        durationMs: 0,
        action: { label: '내려받기 페이지', onClick: () => openReleasePage(status) },
        confirmLabel: '닫기',
      });
      return;
    case 'upToDate':
      if (manual) notify(`최신 버전을 쓰고 있습니다 (rhwpp ${status.current}).`);
      return;
    case 'downloading':
      if (manual) notify(`rhwpp ${latest}을(를) 받는 중입니다. 다 받으면 알려 드립니다.`);
      return;
    case 'error':
      if (manual) notify(`업데이트를 확인하지 못했습니다.\n${status.error ?? ''}`, true);
      return;
    default:
      if (manual) notify('업데이트를 확인하지 못했습니다.', true);
  }
}

async function showPendingNotice(): Promise<void> {
  if (!document.hasFocus()) return;
  const status = await updateTakeNotice().catch(() => null);
  if (status) showStatus(status, false);
}

export function installUpdateNotices(): void {
  if (!isTauri()) return;
  void listen(UPDATE_EVENT, () => void showPendingNotice());
  // 다른 프로그램을 쓰는 동안 받았으면 rhwpp 창으로 돌아올 때 알린다.
  window.addEventListener('focus', () => void showPendingNotice());
  void showPendingNotice();
}

export async function checkForUpdates(): Promise<void> {
  if (!isTauri()) return;
  notify('업데이트를 확인하는 중입니다...');
  showStatus(await updateCheck(), true);
}

export async function toggleAutoUpdate(): Promise<void> {
  if (!isTauri()) return;
  const current = await updateStatus();
  const next = await updateSetAuto(!current.auto);
  if (!next.auto) {
    notify('자동 업데이트를 껐습니다. 도구 › 업데이트 확인으로 직접 확인할 수 있습니다.');
  } else if (next.kind === 'currentUser') {
    notify('자동 업데이트를 켰습니다. 새 버전을 받아 두었다가 프로그램을 끝낼 때 설치합니다.');
  } else if (next.kind === 'allUsers') {
    notify('자동 업데이트를 켰습니다. 새 버전을 받아 두고 알려 드립니다. 알림의 지금 업데이트를 누르면 설치합니다(관리자 확인).');
  } else {
    notify('자동 업데이트 알림을 켰습니다. 설치된 프로그램이 아니어서 새 버전이 나오면 알려 드리기만 합니다.');
  }
}
