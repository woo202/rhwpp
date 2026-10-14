#!/usr/bin/env node
// 데스크톱 프런트엔드(업스트림 rhwp-studio + rhwpp 오버레이)를 빌드한다.
//
//   node scripts/build-web.mjs         dist/ 에 프로덕션 빌드 (tauri build 가 호출)
//   node scripts/build-web.mjs --dev   http://127.0.0.1:1420 개발 서버 (tauri dev 가 호출)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const studioDir = join(root, 'upstream', 'rhwp', 'rhwp-studio');
const dev = process.argv.includes('--dev');
const isWin = process.platform === 'win32';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: isWin });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(join(studioDir, 'package.json'))) {
  console.error('[build:web] upstream/rhwp 가 없습니다. 먼저 `npm run upstream:fetch` 를 실행하세요.');
  process.exit(1);
}
if (!existsSync(join(root, 'upstream', 'rhwp', 'pkg', 'rhwp.js'))) {
  console.error('[build:web] WASM 산출물이 없습니다. 먼저 `npm run build:wasm` 을 실행하세요.');
  process.exit(1);
}

// 업스트림 스튜디오 의존성: package-lock.json 이 바뀌었을 때만 npm ci 를 다시 돈다.
const lockFile = join(studioDir, 'package-lock.json');
const stampFile = join(studioDir, 'node_modules', '.rhwpp-lock-hash');
const lockHash = createHash('sha256').update(readFileSync(lockFile)).digest('hex');
const installed = existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === lockHash;
if (!installed) {
  console.log('[build:web] 업스트림 rhwp-studio 의존성 설치 (npm ci)');
  run('npm', ['ci', '--no-audit', '--no-fund'], studioDir);
  writeFileSync(stampFile, `${lockHash}\n`);
}

const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const config = join(root, 'desktop', 'vite.config.ts');
if (dev) {
  run(process.execPath, [vite, '--config', config], root);
} else {
  run(process.execPath, [vite, 'build', '--config', config], root);
}
