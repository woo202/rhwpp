// node --test desktop/tests/*.test.mjs  (Node 22.18+ 는 .ts 를 직접 불러온다)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baseName,
  dirName,
  documentTitle,
  filtersFromTypes,
  isBrowserReservedKey,
  matchesShortcut,
  mimeTypeFor,
  nativeHandleRecord,
  samePath,
} from '../src/util.ts';

const key = (overrides) => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...overrides });

test('경로 분해: Windows/POSIX 구분자', () => {
  assert.equal(baseName('C:\\문서\\보고서.hwp'), '보고서.hwp');
  assert.equal(baseName('/home/u/a.hwpx'), 'a.hwpx');
  assert.equal(dirName('C:\\문서\\보고서.hwp'), 'C:\\문서\\');
  assert.equal(dirName('보고서.hwp'), '');
});

test('경로 비교는 대소문자·구분자를 무시한다', () => {
  assert.ok(samePath('C:\\Docs\\A.HWP', 'c:/docs/a.hwp'));
  assert.ok(samePath('C:\\Docs\\', 'C:\\docs'));
  assert.ok(!samePath('C:\\Docs\\a.hwp', 'C:\\Docs\\b.hwp'));
});

test('MIME 형식', () => {
  assert.equal(mimeTypeFor('a.HWP'), 'application/x-hwp');
  assert.equal(mimeTypeFor('a.hwpx'), 'application/hwp+zip');
  assert.equal(mimeTypeFor('noext'), 'application/octet-stream');
});

test('파일 선택기 accept → 대화상자 필터', () => {
  const types = [{
    description: 'HWP/HWPX/HML 문서',
    accept: { 'application/x-hwp': ['.hwp'], 'application/hwp+zip': ['.hwpx'], 'application/xml': ['.hml'], 'text/xml': ['.hml'] },
  }];
  const filters = filtersFromTypes(types, false);
  assert.deepEqual(filters, [{ name: 'HWP/HWPX/HML 문서 (*.hwp;*.hwpx;*.hml)', extensions: ['hwp', 'hwpx', 'hml'] }]);
  assert.equal(filtersFromTypes(types, true).at(-1).extensions[0], '*');
  assert.equal(filtersFromTypes([], false)[0].extensions[0], '*', '필터가 없으면 모든 파일');
});

test('IndexedDB 에서 꺼낸 네이티브 핸들 흔적 판별', () => {
  assert.deepEqual(nativeHandleRecord({ __rhwppNative: true, path: 'C:\\a.hwp', name: 'a.hwp', kind: 'file' }), { path: 'C:\\a.hwp', name: 'a.hwp' });
  assert.equal(nativeHandleRecord({ kind: 'file', name: 'a.hwp' }), null, '브라우저 핸들은 건드리지 않는다');
  assert.equal(nativeHandleRecord(null), null);
  assert.equal(nativeHandleRecord({ __rhwppNative: true, path: '' }), null);
});

test('제목 표시줄 문자열', () => {
  assert.equal(documentTitle('보고서.hwp', 'C:\\문서\\보고서.hwp', false).text, '보고서.hwp [C:\\문서\\] - rhwpp');
  assert.equal(documentTitle('보고서.hwp', 'C:\\문서\\보고서.hwp', true).text, '*보고서.hwp [C:\\문서\\] - rhwpp');
  assert.equal(documentTitle('빈 문서 1', null, false).text, '빈 문서 1 - rhwpp');
  assert.equal(documentTitle('', null, true).text, 'rhwpp');
});

test('단축키 일치: 한글 입력 상태에서도 물리 키로 맞춘다', () => {
  const altS = { key: 's', code: 'KeyS', alt: true };
  assert.ok(matchesShortcut(key({ key: 's', code: 'KeyS', altKey: true }), altS));
  assert.ok(matchesShortcut(key({ key: 'ㄴ', code: 'KeyS', altKey: true }), altS));
  assert.ok(!matchesShortcut(key({ key: 's', code: 'KeyS', altKey: true, shiftKey: true }), altS));
  assert.ok(!matchesShortcut(key({ key: 's', code: 'KeyS', ctrlKey: true }), altS));
  assert.ok(matchesShortcut(key({ key: 'F4', ctrlKey: true }), { key: 'f4', ctrl: true }));
});

test('브라우저 예약 키 차단', () => {
  assert.ok(isBrowserReservedKey(key({ key: 'F5' })));
  assert.ok(isBrowserReservedKey(key({ key: 'r', code: 'KeyR', ctrlKey: true })));
  assert.ok(isBrowserReservedKey(key({ key: 'ArrowLeft', altKey: true })));
  assert.ok(isBrowserReservedKey(key({ key: 'F12' })));
  assert.ok(!isBrowserReservedKey(key({ key: 'F12' }), true), '개발 모드에서는 개발자 도구 허용');
  assert.ok(!isBrowserReservedKey(key({ key: 'ArrowLeft', altKey: true, shiftKey: true })));
  assert.ok(!isBrowserReservedKey(key({ key: 's', ctrlKey: true })), '저장은 스튜디오가 처리');
  assert.ok(!isBrowserReservedKey(key({ key: 'b', ctrlKey: true })), '진하게');
});

test('문서 탭 이름', async () => {
  const { tabLabelFromTitle } = await import('../src/util.ts');
  assert.deepEqual(tabLabelFromTitle('*보고서.hwp [C:\\문서\\] - rhwpp'), { name: '보고서.hwp', dirty: true });
  assert.deepEqual(tabLabelFromTitle('새 문서.hwp - rhwpp'), { name: '새 문서.hwp', dirty: false });
  assert.deepEqual(tabLabelFromTitle('rhwpp'), { name: '빈 문서', dirty: false });
});
