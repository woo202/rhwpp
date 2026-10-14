/**
 * 한글 2022 식 "탭 메뉴 + 기본 도구 상자(리본)".
 *
 *  - 메뉴 이름(파일/편집/보기/…)을 누르면 그 메뉴의 도구 상자가 리본에 나타난다.
 *  - 메뉴 이름 옆 ▾ 를 누르면 기존 펼침 메뉴(열림 상자)가 열린다.
 *  - 메뉴 이름을 두 번 누르면 기본 도구 상자를 접거나 편다.
 *
 * "편집" 리본은 업스트림 스튜디오의 기본 도구 상자 그대로다. 나머지 리본 버튼도 스튜디오와
 * 같은 마크업(`.tb-btn[data-cmd]`)으로 만들고, 스튜디오 초기화 전에 DOM 에 넣어 두어
 * 스튜디오가 직접 클릭/활성 상태를 연결하게 한다. 이 함수는 반드시 스튜디오 main.ts 보다
 * 먼저 동기적으로 실행되어야 한다(boot.ts).
 */
import { ICONS } from './icons';

export interface RibbonButton {
  cmd: string;
  label: string;
  /** ICONS 키 */
  icon?: string;
  /** 업스트림 스프라이트 클래스(icon-xxx) */
  sprite?: string;
  /** 글자 아이콘 */
  glyph?: string;
  title?: string;
}

export interface RibbonDef {
  /** data-menu 값 */
  menu: string;
  groups: RibbonButton[][];
}

const b = (cmd: string, label: string, look: Partial<RibbonButton> = {}): RibbonButton => ({ cmd, label, ...look });

/** "편집"은 스튜디오 기본 도구 상자를 쓰므로 여기 없다. */
export const RIBBONS: RibbonDef[] = [
  {
    menu: 'file',
    groups: [
      [
        b('file:new-doc', '새 문서', { icon: 'newDoc', title: '새 문서 (Alt+N)' }),
        b('ext:rhwpp.new-window', '새 창', { icon: 'newWindow', title: '새 창에서 빈 문서 열기 (Ctrl+Alt+N)' }),
        b('file:open', '불러\n오기', { icon: 'open', title: '불러오기 (Alt+O)' }),
        b('ext:rhwpp.reveal', '파일\n위치', { icon: 'reveal', title: '탐색기에서 파일 위치 열기' }),
      ],
      [
        b('file:save', '저장\n하기', { sprite: 'icon-save', title: '저장하기 (Alt+S)' }),
        b('file:save-as', '다른 이름\n으로 저장', { icon: 'saveAs', title: '다른 이름으로 저장하기 (Alt+V)' }),
        b('file:save-as-hwp', 'HWP로\n저장', { icon: 'hwp' }),
        b('file:save-as-hwpx', 'HWPX로\n저장', { icon: 'hwpx' }),
      ],
      [
        b('file:print-to-pdf', 'PDF로\n저장', { icon: 'pdf', title: 'PDF로 저장하기' }),
        b('file:export-html', 'HTML\n내보내기', { icon: 'html' }),
        b('file:export-doc', 'Word\n내보내기', { icon: 'word', title: 'Word 문서(.doc)로 내보내기' }),
      ],
      [
        b('file:page-setup', '편집\n용지', { sprite: 'icon-page-setup', title: '편집 용지 (F7)' }),
        b('file:print', '인쇄', { icon: 'print', title: '인쇄 (Alt+P)' }),
      ],
      [
        b('ext:rhwpp.close', '문서\n닫기', { icon: 'closeDoc', title: '문서 닫기 (Ctrl+F4)' }),
        b('ext:rhwpp.exit', '끝', { icon: 'exit', title: '끝 (Alt+X)' }),
        b('file:about', '제품\n정보', { icon: 'help' }),
      ],
    ],
  },
  {
    menu: 'view',
    groups: [
      [
        b('view:zoom-in', '확대', { icon: 'zoomIn', title: '확대 (Ctrl++)' }),
        b('view:zoom-out', '축소', { icon: 'zoomOut', title: '축소 (Ctrl+-)' }),
        b('view:zoom-100', '100%', { icon: 'zoom100', title: '쪽 윤곽 100%' }),
        b('view:zoom-fit-page', '쪽\n맞춤', { icon: 'fitPage' }),
        b('view:zoom-fit-width', '폭\n맞춤', { icon: 'fitWidth' }),
        b('view:zoom-dialog', '확대/\n축소', { icon: 'zoomDialog', title: '화면 확대/축소' }),
      ],
      [
        b('view:ctrl-mark', '조판\n부호', { sprite: 'icon-ctrl-mark' }),
        b('view:para-mark', '문단\n부호', { sprite: 'icon-para-mark' }),
        b('view:border-transparent', '투명\n선', { icon: 'transparentLine' }),
        b('view:toggle-clip', '잘림\n보기', { icon: 'clip' }),
        b('view:toggle-grid', '격자\n보기', { sprite: 'icon-grid' }),
        b('view:grid-settings', '격자\n설정', { icon: 'gridSettings' }),
      ],
      [
        b('view:form-mode', '양식\n모드', { icon: 'formMode', title: '양식 모드(누름틀만 입력)' }),
        b('view:toolbox-basic', '기본\n도구 상자', { icon: 'toolboxBasic' }),
        b('view:toolbox-format', '서식\n도구 상자', { icon: 'toolboxFormat' }),
      ],
      [
        b('view:theme-light', '밝은\n화면', { icon: 'themeLight' }),
        b('view:theme-dark', '어두운\n화면', { icon: 'themeDark' }),
      ],
    ],
  },
  {
    menu: 'insert',
    groups: [
      [
        b('table:create', '표', { sprite: 'icon-table', title: '표 만들기 (Ctrl+N,T)' }),
        b('insert:shape', '도형', { sprite: 'icon-shape' }),
        b('insert:image', '그림', { sprite: 'icon-image', title: '그림 넣기 (Ctrl+N,I)' }),
        b('insert:textbox', '글상자', { sprite: 'icon-textbox' }),
        b('insert:equation', '수식', { icon: 'equation', title: '수식 (Ctrl+N,M)' }),
      ],
      [
        b('insert:symbols', '문자표', { sprite: 'icon-symbols', title: '문자표 (Alt+F10)' }),
        b('insert:hyperlink', '하이퍼\n링크', { sprite: 'icon-hyperlink' }),
        b('insert:bookmark', '책갈피', { icon: 'bookmark' }),
        b('insert:field', '필드\n입력', { icon: 'field', title: '필드(누름틀) 입력' }),
      ],
      [
        b('insert:footnote', '각주', { sprite: 'icon-footnote', title: '각주 (Ctrl+N,N)' }),
        b('insert:endnote', '미주', { sprite: 'icon-endnote', title: '미주 (Ctrl+N,E)' }),
        b('insert:endnote-shape', '주석\n모양', { sprite: 'icon-endnote' }),
      ],
      [
        b('insert:caption-toggle', '캡션\n넣기', { icon: 'caption' }),
        b('insert:para-band', '문단 띠', { icon: 'paraBand' }),
      ],
      [
        b('insert:arrange-front', '맨 앞\n으로', { icon: 'arrangeFront' }),
        b('insert:arrange-back', '맨 뒤\n로', { icon: 'arrangeBack' }),
        b('insert:group-shapes', '개체\n묶기', { icon: 'group' }),
        b('insert:ungroup-shapes', '개체\n풀기', { icon: 'ungroup' }),
        b('format:object-properties', '개체\n속성', { sprite: 'icon-obj-props' }),
      ],
    ],
  },
  {
    menu: 'format',
    groups: [
      [
        b('format:char-shape', '글자\n모양', { sprite: 'icon-char-shape', title: '글자 모양 (Alt+L)' }),
        b('format:para-shape', '문단\n모양', { sprite: 'icon-para-shape', title: '문단 모양 (Alt+T)' }),
        b('format:style-dialog', '스타일', { icon: 'style', title: '스타일 (F6)' }),
        b('edit:format-copy', '모양\n복사', { sprite: 'icon-format-copy', title: '모양 복사 (Alt+C)' }),
      ],
      [
        b('format:para-num-shape', '문단 번호\n모양', { icon: 'numberShape' }),
        b('format:bullet-shape', '글머리표\n모양', { icon: 'bulletShape' }),
        b('format:level-increase', '한 수준\n증가', { icon: 'levelUp' }),
        b('format:level-decrease', '한 수준\n감소', { icon: 'levelDown' }),
      ],
      [
        b('format:font-size-increase', '글자\n크게', { icon: 'fontBigger', title: '글자 크기 크게 (Alt+Shift+E)' }),
        b('format:font-size-decrease', '글자\n작게', { icon: 'fontSmaller', title: '글자 크기 작게 (Alt+Shift+R)' }),
        b('format:line-spacing-increase', '줄 간격\n늘림', { icon: 'lineSpacingUp', title: '줄 간격 늘림 (Alt+Shift+Z)' }),
        b('format:line-spacing-decrease', '줄 간격\n줄임', { icon: 'lineSpacingDown', title: '줄 간격 줄임 (Alt+Shift+A)' }),
      ],
      [
        b('format:align-justify', '양쪽\n정렬', { icon: 'alignJustify', title: '양쪽 정렬 (Ctrl+Shift+M)' }),
        b('format:align-left', '왼쪽\n정렬', { icon: 'alignLeft', title: '왼쪽 정렬 (Ctrl+Shift+L)' }),
        b('format:align-center', '가운데\n정렬', { icon: 'alignCenter', title: '가운데 정렬 (Ctrl+Shift+C)' }),
        b('format:align-right', '오른쪽\n정렬', { icon: 'alignRight', title: '오른쪽 정렬 (Ctrl+Shift+R)' }),
        b('format:align-distribute', '배분\n정렬', { icon: 'alignDistribute', title: '배분 정렬 (Ctrl+Shift+T)' }),
      ],
    ],
  },
  {
    menu: 'page',
    groups: [
      [
        b('page:setup', '편집\n용지', { sprite: 'icon-page-setup', title: '편집 용지 (F7)' }),
        b('page:page-border', '쪽 테두리/\n배경', { icon: 'pageBorder' }),
      ],
      [
        b('page:header-create', '머리말', { sprite: 'icon-header', title: '머리말 (Ctrl+N,H)' }),
        b('page:footer-create', '꼬리말', { sprite: 'icon-footer' }),
        b('page:new-page-num', '새 번호로\n시작', { icon: 'newNumber' }),
        b('page:hide-current', '현재 쪽만\n감추기', { icon: 'hidePage' }),
      ],
      [
        b('page:break', '쪽\n나누기', { icon: 'pageBreak', title: '쪽 나누기 (Ctrl+Enter)' }),
        b('page:column-break', '단\n나누기', { icon: 'columnBreak', title: '단 나누기 (Ctrl+Shift+Enter)' }),
      ],
      [
        b('page:col-1', '단\n하나', { icon: 'col1' }),
        b('page:col-2', '단\n둘', { icon: 'col2' }),
        b('page:col-3', '단\n셋', { icon: 'col3' }),
        b('page:col-settings', '다단\n설정', { icon: 'colSettings', title: '다단 설정 (Ctrl+Alt+Enter)' }),
        b('page:section-settings', '구역\n설정', { icon: 'section' }),
      ],
    ],
  },
  {
    menu: 'table',
    groups: [
      [
        b('table:create', '표\n만들기', { sprite: 'icon-table' }),
        b('table:cell-props', '표/셀\n속성', { icon: 'cellProps', title: '표/셀 속성 (P)' }),
      ],
      [
        b('table:insert-row-col', '줄/칸\n추가', { icon: 'insertRow', title: '줄/칸 추가하기 (Alt+Insert)' }),
        b('table:delete-row-col', '줄/칸\n지우기', { icon: 'deleteRow', title: '줄/칸 지우기 (Alt+Delete)' }),
        b('table:cell-split', '셀\n나누기', { icon: 'splitCell', title: '셀 나누기 (S)' }),
        b('table:cell-merge', '셀\n합치기', { icon: 'mergeCell', title: '셀 합치기 (M)' }),
      ],
      [
        b('table:cell-height-equal', '셀 높이를\n같게', { icon: 'equalHeight', title: '셀 높이를 같게 (H)' }),
        b('table:cell-width-equal', '셀 너비를\n같게', { icon: 'equalWidth', title: '셀 너비를 같게 (W)' }),
        b('table:transpose-copy', '행/열\n바꿈 복사', { icon: 'transposeCopy' }),
      ],
      [
        b('table:block-formula', '계산식', { icon: 'formula' }),
        b('table:block-sum', '블록\n합계', { icon: 'sum', title: '블록 합계 (Ctrl+Shift+S)' }),
        b('table:block-avg', '블록\n평균', { icon: 'avg', title: '블록 평균 (Ctrl+Shift+A)' }),
        b('table:block-product', '블록\n곱', { icon: 'product', title: '블록 곱 (Ctrl+Shift+P)' }),
      ],
      [
        b('table:thousand-sep', '1,000\n단위 쉼표', { icon: 'thousands' }),
        b('table:decimal-add', '자릿점\n넣기', { icon: 'decimalAdd' }),
        b('table:decimal-remove', '자릿점\n빼기', { icon: 'decimalRemove' }),
      ],
    ],
  },
  {
    menu: 'tool',
    groups: [
      [
        b('edit:find', '찾기', { sprite: 'icon-find', title: '찾기 (Ctrl+F)' }),
        b('edit:find-replace', '찾아\n바꾸기', { sprite: 'icon-find-replace', title: '찾아 바꾸기 (Ctrl+F2)' }),
        b('edit:goto', '찾아\n가기', { glyph: '↷', title: '찾아가기 (Alt+G)' }),
      ],
      [
        b('edit:compare-documents', '문서\n비교', { icon: 'compare', title: '문서 비교 (Alt+Shift+V)' }),
        b('edit:document-history', '문서 이력\n관리', { icon: 'history', title: '문서 이력 관리 (Ctrl+Shift+H)' }),
      ],
      [
        b('ext:rhwpp.command-palette', '명령\n찾기', { icon: 'palette', title: '모든 명령 찾기 (Ctrl+Shift+P)' }),
        b('tool:options', '환경\n설정', { icon: 'options' }),
      ],
    ],
  },
];

/** 리본이 있는 메뉴(편집 포함). */
export const RIBBON_MENUS = ['file', 'edit', 'view', 'insert', 'format', 'page', 'table', 'tool'];
const DEFAULT_RIBBON = 'edit';
const STORAGE_KEY = 'rhwpp.ribbon';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
}

function iconMarkup(button: RibbonButton): string {
  if (button.sprite) return `<span class="tb-sprite ${button.sprite}"></span>`;
  if (button.icon && ICONS[button.icon]) return `<span class="tb-svg">${ICONS[button.icon]}</span>`;
  return `<span class="tb-icon-text">${escapeHtml(button.glyph ?? '•')}</span>`;
}

export function buttonMarkup(button: RibbonButton): string {
  const title = escapeHtml(button.title ?? button.label.replace(/\n/g, ' '));
  const label = button.label.split('\n').map(escapeHtml).join('<br/>');
  return `<button type="button" class="tb-btn rhwpp-tb-btn" data-cmd="${button.cmd}" title="${title}">${iconMarkup(button)}<span class="tb-label">${label}</span></button>`;
}

function readStoredRibbon(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && RIBBON_MENUS.includes(stored)) return stored;
  } catch {
    // 저장소를 쓸 수 없는 환경
  }
  return DEFAULT_RIBBON;
}

let track: HTMLElement | null = null;
let menuBar: HTMLElement | null = null;
const syntheticEvents = new WeakSet<Event>();

export function activeRibbon(): string {
  return track?.dataset.rhwppRibbon ?? DEFAULT_RIBBON;
}

export function selectRibbon(menu: string): void {
  if (!track || !RIBBON_MENUS.includes(menu)) return;
  track.dataset.rhwppRibbon = menu;
  for (const item of menuBar?.querySelectorAll<HTMLElement>('.menu-item[data-menu]') ?? []) {
    item.classList.toggle('rhwpp-tab-active', item.dataset.menu === menu);
  }
  const viewport = document.getElementById('icon-toolbar-viewport');
  if (viewport) viewport.scrollLeft = 0;
  try {
    localStorage.setItem(STORAGE_KEY, menu);
  } catch {
    // 무시
  }
}

function openDropdown(item: HTMLElement): void {
  const title = item.querySelector<HTMLElement>('.menu-title');
  if (!title) return;
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  syntheticEvents.add(event);
  title.dispatchEvent(event);
}

function closeOpenDropdown(): void {
  const open = menuBar?.querySelector<HTMLElement>('.menu-item.open');
  if (open) openDropdown(open); // 같은 메뉴 제목을 다시 누르면 닫힌다.
}

function installTabs(): void {
  if (!menuBar) return;
  for (const item of menuBar.querySelectorAll<HTMLElement>('.menu-item[data-menu]')) {
    item.classList.add('rhwpp-tab');
    const title = item.querySelector('.menu-title');
    if (!title || item.querySelector('.rhwpp-tab-arrow')) continue;
    const arrow = document.createElement('span');
    arrow.className = 'rhwpp-tab-arrow';
    arrow.setAttribute('role', 'button');
    arrow.setAttribute('aria-label', `${title.textContent ?? ''} 메뉴 열기`);
    arrow.title = '열림 상자';
    arrow.textContent = '▾';
    title.after(arrow);
  }

  menuBar.addEventListener('mousedown', (event) => {
    if (syntheticEvents.has(event) || event.button !== 0) return;
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('.menu-item[data-menu]');
    if (!item) return;
    if (target.closest('.rhwpp-tab-arrow')) {
      event.preventDefault();
      event.stopPropagation();
      openDropdown(item);
      return;
    }
    if (!target.closest('.menu-title')) return;
    const menu = item.dataset.menu ?? '';
    if (!RIBBON_MENUS.includes(menu)) return;
    event.preventDefault();
    event.stopPropagation();
    closeOpenDropdown();
    selectRibbon(menu);
  }, true);

  menuBar.addEventListener('dblclick', (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest('.menu-item[data-menu] .menu-title')) return;
    document.getElementById('toolbox-basic-toggle')?.click();
  });
}

/** 스튜디오 편집 모드 도구(머리말/꼬리말, 주석, 개체 회전)가 나타나면 편집 리본으로 돌아간다. */
function followStudioModeGroups(): void {
  if (!track) return;
  const groups = track.querySelectorAll<HTMLElement>('.tb-mode-group, .tb-headerfooter-group, .tb-rotate-group');
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const el = record.target as HTMLElement;
      if (!el.hidden && activeRibbon() !== 'edit') {
        selectRibbon('edit');
        return;
      }
    }
  });
  for (const group of groups) observer.observe(group, { attributes: true, attributeFilter: ['hidden'] });
}

/** 리본 버튼의 활성/비활성을 스튜디오 판정(canExecute)에 맞춘다. */
export function syncRibbonStates(isEnabled: (cmd: string) => boolean): void {
  if (!track) return;
  const active = activeRibbon();
  if (active === 'edit') return;
  for (const btn of track.querySelectorAll<HTMLElement>(`.rhwpp-tb-btn[data-cmd]`)) {
    if (btn.closest(`[data-ribbon="${active}"]`) === null) continue;
    btn.classList.toggle('disabled', !isEnabled(btn.dataset.cmd!));
  }
}

export function installRibbon(): void {
  track = document.querySelector<HTMLElement>('#icon-toolbar .tb-scroll-track');
  menuBar = document.getElementById('menu-bar');
  if (!track || !menuBar) {
    console.warn('[rhwpp] 도구 상자 구조를 찾지 못해 탭 리본을 건너뜁니다.');
    return;
  }

  // 스튜디오 기본 도구 상자 = 편집 리본.
  for (const child of Array.from(track.children) as HTMLElement[]) {
    if (!child.dataset.ribbon) child.dataset.ribbon = 'edit';
  }

  const fragment = document.createDocumentFragment();
  for (const ribbon of RIBBONS) {
    ribbon.groups.forEach((group, index) => {
      if (index > 0) {
        const sep = document.createElement('span');
        sep.className = 'tb-sep';
        sep.dataset.ribbon = ribbon.menu;
        fragment.append(sep);
      }
      const div = document.createElement('div');
      div.className = 'tb-group';
      div.dataset.ribbon = ribbon.menu;
      div.innerHTML = group.map(buttonMarkup).join('');
      fragment.append(div);
    });
  }
  track.append(fragment);

  installTabs();
  selectRibbon(readStoredRibbon());
  followStudioModeGroups();
}
