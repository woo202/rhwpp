#!/usr/bin/env node
// 업스트림 rhwp 코어를 WebAssembly 로 빌드한다 (upstream/rhwp/pkg).
//
//   node scripts/build-wasm.mjs           고정 커밋 기준으로 이미 빌드돼 있으면 건너뛴다
//   node scripts/build-wasm.mjs --force   항상 다시 빌드한다
//   node scripts/build-wasm.mjs --no-opt  wasm-opt 최적화를 생략한다 (binaryen 을 받을 수 없는 환경)
//
// 업스트림 Docker 빌드(scripts/wasm-pack-locked.sh)와 같은 산출물을 만든다:
// wasm-pack --target web --release, Cargo.lock 고정, 결과를 rhwp-studio/public 에도 복사.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstreamDir = join(root, 'upstream', 'rhwp');
const pkgDir = join(upstreamDir, 'pkg');
const stampPath = join(pkgDir, '.rhwpp-build');
const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const noOpt = args.has('--no-opt') || process.env.RHWPP_WASM_NO_OPT === '1';

if (!existsSync(join(upstreamDir, 'Cargo.toml'))) {
  console.error('[build:wasm] upstream/rhwp 가 없습니다. 먼저 `npm run upstream:fetch` 를 실행하세요.');
  process.exit(1);
}

function headCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstreamDir, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

const commit = headCommit();
const stamp = `${commit}${noOpt ? ' no-opt' : ''}`;
const artifacts = ['rhwp.js', 'rhwp_bg.wasm'];
const upToDate = artifacts.every((name) => existsSync(join(pkgDir, name)))
  && existsSync(stampPath)
  && readFileSync(stampPath, 'utf8').trim() === stamp;

if (upToDate && !force) {
  console.log(`[build:wasm] 최신 상태입니다 (${commit.slice(0, 12)}). --force 로 다시 빌드할 수 있습니다.`);
  process.exit(0);
}

const wasmPackArgs = ['build', '--target', 'web', '--release'];
if (noOpt) wasmPackArgs.push('--no-opt');
wasmPackArgs.push('--', '--locked');

console.log(`[build:wasm] wasm-pack ${wasmPackArgs.join(' ')}  (cwd: upstream/rhwp)`);
const result = spawnSync('wasm-pack', wasmPackArgs, {
  cwd: upstreamDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) {
  console.error('[build:wasm] wasm-pack 을 실행하지 못했습니다. `cargo install wasm-pack@0.15.0` 으로 설치하세요.');
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('[build:wasm] 빌드 실패. binaryen 다운로드가 막힌 환경이면 --no-opt 를 붙여 보세요.');
  process.exit(result.status ?? 1);
}

for (const name of artifacts) {
  const from = join(pkgDir, name);
  if (!existsSync(from)) {
    console.error(`[build:wasm] 산출물이 없습니다: ${from}`);
    process.exit(1);
  }
  copyFileSync(from, join(upstreamDir, 'rhwp-studio', 'public', name));
}
writeFileSync(stampPath, `${stamp}\n`);
console.log('[build:wasm] 완료');
