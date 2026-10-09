#!/usr/bin/env node
// 업스트림 rhwp 체크아웃 관리.
//
//   node scripts/upstream.mjs fetch    upstream.json 에 고정된 커밋을 upstream/rhwp 에 준비한다
//   node scripts/upstream.mjs update   업스트림 브랜치 최신 커밋으로 upstream.json 을 갱신하고 체크아웃한다
//   node scripts/upstream.mjs status   고정 커밋과 현재 체크아웃 상태를 출력한다
//
// 업스트림 저장소는 문서/샘플/PDF 때문에 수 GB 에 달한다. 빌드에 필요한 경로만
// blobless partial clone + sparse checkout 으로 받아 CI 와 개발 환경의 비용을 줄인다.
// upstream/rhwp 가 이미 전체 클론(또는 그 심볼릭 링크)이면 sparse 설정을 건드리지 않는다.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'upstream.json');
const upstreamDir = join(root, 'upstream', 'rhwp');

/** 빌드에 필요 없는 무거운 최상위 경로. */
const EXCLUDED_TOP_LEVEL = ['mydocs', 'pdf', 'samples', 'tools', 'gym', 'fuzz', 'saved'];

/** 제외한 경로 중에서도 크레이트가 include_bytes! 로 읽는 파일. */
const REQUIRED_FILES = ['saved/blank2010.hwp'];

function readLock() {
  return JSON.parse(readFileSync(lockPath, 'utf8'));
}

function writeLock(lock) {
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd ?? upstreamDir,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
}

function gitOut(args, cwd = upstreamDir) {
  return git(args, { cwd, capture: true }).trim();
}

function isGitCheckout(dir) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isSparse() {
  try {
    return gitOut(['config', '--get', 'core.sparseCheckout']) === 'true';
  } catch {
    return false;
  }
}

/** Cargo 워크스페이스 멤버 중 제외 경로 아래에 있는 것들의 매니페스트/소스를 되살린다. */
function workspaceMemberPatterns() {
  const cargoToml = readFileSync(join(upstreamDir, 'Cargo.toml'), 'utf8');
  const match = cargoToml.match(/\[workspace\][^[]*?members\s*=\s*\[([^\]]*)\]/s);
  if (!match) return [];
  const members = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const patterns = [];
  for (const member of members) {
    if (member === '.' || member.includes('*')) continue;
    const top = member.split('/')[0];
    if (!EXCLUDED_TOP_LEVEL.includes(top)) continue;
    patterns.push(`/${member}/Cargo.toml`, `/${member}/build.rs`, `/${member}/src/`);
  }
  return patterns;
}

function sparsePatterns(withMembers) {
  return [
    '/*',
    ...EXCLUDED_TOP_LEVEL.map((dir) => `!/${dir}/`),
    ...REQUIRED_FILES.map((file) => `/${file}`),
    ...(withMembers ? workspaceMemberPatterns() : []),
  ];
}

function applySparse(withMembers) {
  git(['sparse-checkout', 'set', '--no-cone', ...sparsePatterns(withMembers)]);
}

function checkoutCommit(lock) {
  const head = gitOut(['rev-parse', 'HEAD']);
  if (head === lock.commit) return;
  try {
    gitOut(['cat-file', '-e', `${lock.commit}^{commit}`]);
  } catch {
    const filter = isSparse() ? ['--filter=blob:none'] : [];
    git(['fetch', '--depth', '1', ...filter, 'origin', lock.commit]);
  }
  git(['checkout', '--detach', lock.commit]);
}

function initSparseClone(lock) {
  mkdirSync(upstreamDir, { recursive: true });
  git(['init', '--quiet']);
  git(['remote', 'add', 'origin', lock.repo]);
  // Windows 체크아웃에서도 rhwp-studio/public/fonts 심볼릭 링크를 살려 두려 시도한다.
  // 권한이 없으면 git 이 일반 파일로 떨어뜨리고, 빌드 스크립트가 글꼴을 직접 복사한다.
  git(['config', 'core.symlinks', 'true']);
  git(['config', 'core.longpaths', 'true']);
  git(['config', 'extensions.partialClone', 'origin']);
  git(['sparse-checkout', 'init', '--no-cone']);
  applySparse(false);
  git(['fetch', '--depth', '1', '--filter=blob:none', 'origin', lock.commit]);
  git(['checkout', '--detach', 'FETCH_HEAD']);
  // 루트 Cargo.toml 을 읽을 수 있게 된 뒤 워크스페이스 멤버 경로를 추가한다.
  applySparse(true);
}

function fetchUpstream() {
  const lock = readLock();
  if (!existsSync(upstreamDir) || !isGitCheckout(upstreamDir)) {
    console.log(`[upstream] ${lock.repo} @ ${lock.commit.slice(0, 12)} 를 sparse checkout 합니다`);
    initSparseClone(lock);
  } else {
    checkoutCommit(lock);
    if (isSparse()) applySparse(true);
  }
  console.log(`[upstream] 준비 완료: ${gitOut(['rev-parse', 'HEAD'])}`);
}

function updateUpstream() {
  const lock = readLock();
  if (!existsSync(upstreamDir) || !isGitCheckout(upstreamDir)) fetchUpstream();
  const filter = isSparse() ? ['--filter=blob:none'] : [];
  git(['fetch', '--depth', '1', ...filter, 'origin', lock.branch]);
  const latest = gitOut(['rev-parse', 'FETCH_HEAD']);
  if (latest === lock.commit) {
    console.log(`[upstream] 이미 최신입니다: ${latest}`);
    return;
  }
  git(['checkout', '--detach', latest]);
  if (isSparse()) applySparse(true);
  const cargoToml = readFileSync(join(upstreamDir, 'Cargo.toml'), 'utf8');
  const version = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? lock.version;
  writeLock({ ...lock, commit: latest, version });
  console.log(`[upstream] ${lock.commit.slice(0, 12)} → ${latest.slice(0, 12)} (v${version})`);
  console.log('[upstream] npm run build 로 다시 빌드하고 동작을 확인한 뒤 upstream.json 을 커밋하세요.');
}

function status() {
  const lock = readLock();
  console.log(`고정 커밋 : ${lock.commit} (v${lock.version})`);
  if (!existsSync(upstreamDir) || !isGitCheckout(upstreamDir)) {
    console.log('체크아웃  : 없음 (npm run upstream:fetch)');
    return;
  }
  const head = gitOut(['rev-parse', 'HEAD']);
  console.log(`체크아웃  : ${head}${head === lock.commit ? '' : '  ← 고정 커밋과 다름'}`);
  console.log(`sparse    : ${isSparse() ? '예' : '아니오 (전체 클론)'}`);
}

const command = process.argv[2] ?? 'fetch';
switch (command) {
  case 'fetch': fetchUpstream(); break;
  case 'update': updateUpstream(); break;
  case 'status': status(); break;
  default:
    console.error(`알 수 없는 명령: ${command} (fetch | update | status)`);
    process.exit(2);
}
