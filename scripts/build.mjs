// 재현 가능한 빌드: esbuild로 main·preload·hook·renderer·통합 테스트를 out/에 번들한다.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');
// --prod(npm run dist): 소스맵 없이 렌더러 압축. 환경변수 대신 인자로 받는다(Windows cmd에서 VAR=값 문법 불가)
const prod = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

rmSync(out, { recursive: true, force: true });

/**
 * 제목줄 로고(리뷰 이월 C-1): 원본 logo1.png(700px·268KB)를 그대로 CSS에 넣지 않고 40×40으로 줄여 data URL로 렌더러에 넣는다.
 * 줄이기는 Electron nativeImage(scripts/make-logo.cjs). 실패하면 원본으로 대신하고 경고만 낸다(빌드는 계속).
 */
function logoDataUrl() {
  const src = join(root, 'src/img/logo1.png');
  const small = join(out, 'gen/logo1-40.png'); // 패키지에 넣지 않는 중간 산출물
  // CTD_SKIP_LOGO=1: Electron을 띄우는 축소 단계를 건너뛰고 원본을 넣는다(빠른 반복 빌드·Electron 실행이 어려운 환경용)
  if (process.env.CTD_SKIP_LOGO === '1') {
    console.warn('CTD_SKIP_LOGO=1: logo resize skipped, using original');
    return `data:image/png;base64,${readFileSync(src).toString('base64')}`;
  }
  try {
    const electron = createRequire(import.meta.url)('electron');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFileSync(electron, [join(root, 'scripts/make-logo.cjs'), src, small, '40'], { env, stdio: 'pipe', timeout: 60000 });
    if (existsSync(small)) return `data:image/png;base64,${readFileSync(small).toString('base64')}`;
  } catch (e) {
    console.warn(`logo resize failed, using original: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  return `data:image/png;base64,${readFileSync(src).toString('base64')}`;
}
const logoUrl = logoDataUrl();

const nodeCommon = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: !prod, logLevel: 'warning', external: ['electron'] };

await Promise.all([
  build({ ...nodeCommon, entryPoints: [join(root, 'src/main/index.ts')], outfile: join(out, 'main/index.js') }),
  build({ ...nodeCommon, entryPoints: [join(root, 'src/preload/index.ts')], outfile: join(out, 'preload/index.js') }),
  build({ ...nodeCommon, entryPoints: [join(root, 'src/hook/hookRecorder.ts')], outfile: join(out, 'hook/hookRecorder.js'), sourcemap: false }),
  build({ ...nodeCommon, entryPoints: [join(root, 'src/hook/statusLine.ts')], outfile: join(out, 'hook/statusLine.js'), sourcemap: false }),
  build({ ...nodeCommon, entryPoints: [join(root, 'tests/integration/psmux-itest.ts')], outfile: join(out, 'itest/psmux-itest.js') }),
  build({
    entryPoints: [join(root, 'src/renderer/main.tsx')],
    outfile: join(out, 'renderer/app.js'),
    bundle: true, platform: 'browser', format: 'iife', target: 'chrome130',
    jsx: 'automatic', jsxImportSource: 'preact', sourcemap: !prod, minify: prod, logLevel: 'warning',
    // 메뉴 아이콘(src/img/*.png)은 CSS mask-image의 data URL로 번들에 넣는다(asar 안에서도 별도 파일 없이 로드)
    loader: { '.css': 'css', '.png': 'dataurl' },
    // 제목줄 로고 축소본(data URL). App.tsx가 인라인 배경으로 쓴다
    define: { __LOGO_DATA_URL__: JSON.stringify(logoUrl) },
  }),
]);
mkdirSync(join(out, 'renderer'), { recursive: true });
copyFileSync(join(root, 'src/renderer/index.html'), join(out, 'renderer/index.html'));
// 창·작업표시줄 아이콘(사용자 제공 logo2.ico, 16~256px). BrowserWindow가 읽으므로 asar 밖(asarUnpack)에 둔다
mkdirSync(join(out, 'assets'), { recursive: true });
copyFileSync(join(root, 'src/img/logo2.ico'), join(out, 'assets/app.ico'));
console.log('build ok ->', out);
