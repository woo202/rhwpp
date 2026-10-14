/**
 * rhwpp 데스크톱 프런트엔드 빌드 설정.
 *
 * 업스트림 rhwp-studio 를 수정하지 않고 그대로 빌드하되, 다음을 덧입힌다.
 *  - 업스트림 vite.config.ts 를 Vite 로더로 읽어 alias/define/플러그인을 상속한다
 *    (업스트림이 설정을 바꿔도 동기화만 하면 따라간다).
 *  - PWA(Service Worker)는 데스크톱 앱에서 쓸모가 없고 tauri:// 프로토콜과 충돌하므로 뺀다.
 *  - 외부 CDN 웹폰트를 끄고 번들 글꼴만 쓴다(오프라인 동작).
 *  - index.html 에 데스크톱 부트 스크립트를 스튜디오 main.ts 보다 먼저 주입한다.
 *  - 일부 업스트림 모듈을 데스크톱 래퍼로 바꿔 끼운다(MODULE_OVERRIDES).
 */
import { cpSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadConfigFromFile, mergeConfig, type Plugin, type PluginOption, type UserConfig } from 'vite';

const desktopDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(desktopDir, '..');
const upstreamRoot = resolve(repoRoot, 'upstream', 'rhwp');
const studioDir = join(upstreamRoot, 'rhwp-studio');
/** Vite 는 심볼릭 링크를 실제 경로로 풀어 모듈 ID 를 만든다. 비교용 실제 경로. */
const studioRealDir = existsSync(studioDir) ? realpathSync(studioDir) : studioDir;
const desktopSrc = join(desktopDir, 'src');
const outDir = join(repoRoot, 'dist');

const upstreamLock = JSON.parse(readFileSync(join(repoRoot, 'upstream.json'), 'utf8')) as {
  commit: string;
  version: string;
};
const appPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };

/** 업스트림 모듈 → 데스크톱 래퍼. 래퍼 자신은 원본을 그대로 import 할 수 있다. */
const MODULE_OVERRIDES: Record<string, string> = {
  [join(studioRealDir, 'src', 'recent', 'recent-store.ts')]: join(desktopSrc, 'overrides', 'recent-store.ts'),
  [join(studioRealDir, 'src', 'recovery', 'autosave-store.ts')]: join(desktopSrc, 'overrides', 'autosave-store.ts'),
};

/** 업스트림 public/ 에서 복사되지만 데스크톱 번들에서는 쓰지 않는 파일(웹 데모용). */
const UNUSED_PUBLIC_ENTRIES = ['rhwp.js', 'rhwp_bg.wasm', 'rhwp.d.ts', 'rhwp_bg.wasm.d.ts', 'samples'];

const VIRTUAL_PREFIX = '/@rhwpp/';

function normalizePath(path: string): string {
  return normalize(path.split('?')[0]).replace(/\\/g, '/').toLowerCase();
}

function isPwaPlugin(plugin: PluginOption): boolean {
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin) || plugin instanceof Promise) return false;
  const name = (plugin as Plugin).name ?? '';
  return name.startsWith('vite-plugin-pwa');
}

function stripPwa(plugins: PluginOption[] | undefined): PluginOption[] {
  const result: PluginOption[] = [];
  for (const plugin of plugins ?? []) {
    if (Array.isArray(plugin)) {
      result.push(stripPwa(plugin));
    } else if (!isPwaPlugin(plugin)) {
      result.push(plugin);
    }
  }
  return result;
}

/**
 * `rhwp-studio/public/fonts` 는 `../../assets/fonts` 심볼릭 링크다. Windows 체크아웃에서
 * 심볼릭 링크가 일반 파일로 풀리면 글꼴이 빠지므로 직접 서빙/복사한다.
 */
function fontsDir(): string {
  return join(upstreamRoot, 'assets', 'fonts');
}

function publicFontsIsDirectory(): boolean {
  const link = join(studioDir, 'public', 'fonts');
  try {
    return statSync(link).isDirectory();
  } catch {
    return false;
  }
}

function rhwppDesktopPlugin(): Plugin {
  const overrides = new Map(
    Object.entries(MODULE_OVERRIDES).map(([from, to]) => [normalizePath(from), to]),
  );
  const overrideFiles = new Set(Object.values(MODULE_OVERRIDES).map(normalizePath));

  return {
    name: 'rhwpp-desktop',
    enforce: 'pre',

    async resolveId(source, importer, options) {
      if (source.startsWith(VIRTUAL_PREFIX)) {
        return join(desktopSrc, source.slice(VIRTUAL_PREFIX.length));
      }
      // 래퍼 파일 안에서의 import 는 원본으로 보낸다.
      if (importer && overrideFiles.has(normalizePath(importer))) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const replacement = overrides.get(normalizePath(resolved.id));
      return replacement ?? null;
    },

    transform(code, id) {
      // 스튜디오 내부 서비스를 데스크톱 오버레이에 노출한다. 업스트림이 이름을 바꿔도
      // typeof 검사 덕분에 런타임 오류 없이 오버레이가 공개 API 폴백으로 동작한다.
      if (normalizePath(id) !== normalizePath(join(studioRealDir, 'src', 'main.ts'))) return null;
      const exposed = ['wasm', 'eventBus', 'documentState', 'commandServices', 'dispatcher', 'registry', 'automation', 'plugins', 'autosaveManager'];
      const entries = exposed
        .map((name) => `${name}: typeof ${name} !== 'undefined' ? ${name} : undefined`)
        .join(',\n    ');
      return {
        code: `${code}\n\n// --- rhwpp desktop bridge (빌드 시 주입) ---\ntry {\n  (window as any).__rhwppInternals = {\n    ${entries},\n  };\n  window.dispatchEvent(new CustomEvent('rhwpp:studio-ready'));\n} catch (error) {\n  console.warn('[rhwpp] 내부 서비스 노출 실패', error);\n}\n`,
        map: null,
      };
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const mainScript = '<script type="module" src="/src/main.ts"></script>';
        if (!html.includes(mainScript)) {
          throw new Error('[rhwpp] 업스트림 index.html 에서 main.ts 스크립트를 찾지 못했습니다.');
        }
        return html
          .replace('<html lang="ko">', '<html lang="ko" class="rhwpp" data-rhwpp-skin="hangul">')
          .replace(/<title>[^<]*<\/title>/, '<title>rhwpp</title>')
          .replace(
            mainScript,
            `<script type="module" src="${VIRTUAL_PREFIX}boot.ts"></script>\n  ${mainScript}`,
          );
      },
    },

    configureServer(server) {
      if (publicFontsIsDirectory()) return;
      server.middlewares.use('/fonts', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        if (rel.includes('..')) return next();
        const file = join(fontsDir(), rel);
        if (!existsSync(file)) return next();
        const types: Record<string, string> = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };
        res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },

    closeBundle() {
      const target = join(outDir, 'fonts');
      let ok = false;
      try {
        ok = lstatSync(target).isDirectory();
      } catch {
        ok = false;
      }
      if (!ok && existsSync(fontsDir())) {
        rmSync(target, { force: true });
        cpSync(fontsDir(), target, { recursive: true, force: true });
      }
      for (const entry of UNUSED_PUBLIC_ENTRIES) {
        rmSync(join(outDir, entry), { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig(async (env) => {
  const loaded = await loadConfigFromFile(env, join(studioDir, 'vite.config.ts'), studioDir);
  if (!loaded) throw new Error(`[rhwpp] 업스트림 설정을 읽지 못했습니다: ${studioDir}/vite.config.ts`);
  const upstream = loaded.config as UserConfig;

  const base: UserConfig = { ...upstream, plugins: stripPwa(upstream.plugins as PluginOption[]) };

  const desktop: UserConfig = {
    root: studioDir,
    base: '/',
    clearScreen: false,
    envPrefix: ['VITE_', 'TAURI_ENV_'],
    define: {
      __RHWP_DISABLE_EXTERNAL_WEBFONTS__: 'true',
      __RHWPP_VERSION__: JSON.stringify(appPkg.version),
      __RHWPP_UPSTREAM_COMMIT__: JSON.stringify(upstreamLock.commit),
      __RHWPP_UPSTREAM_VERSION__: JSON.stringify(upstreamLock.version),
    },
    plugins: [rhwppDesktopPlugin()],
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      // WebView2 는 최신 Chromium 이므로 구형 브라우저 대응 코드가 필요 없다.
      modulePreload: { polyfill: false },
      chunkSizeWarningLimit: 4096,
    },
    server: {
      host: '127.0.0.1',
      port: 1420,
      strictPort: true,
      fs: {
        allow: [studioDir, studioRealDir, upstreamRoot, realpathSync(upstreamRoot), desktopDir, join(repoRoot, 'node_modules')],
      },
    },
  };

  return mergeConfig(base, desktop);
});
