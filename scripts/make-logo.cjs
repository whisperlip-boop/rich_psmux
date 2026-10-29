// 제목줄 로고 축소본: src/img/logo1.png(700px, 원본 수정 안 함) → 40×40 PNG(20px 표시의 2배, 고배율 대비).
// 새 의존성 없이 Electron nativeImage로 줄인다(make-icon.cjs와 같은 방식). build.mjs가 Electron으로 실행한다.
// 실행: electron scripts/make-logo.cjs <입력 png> <출력 png> <크기>
const { app, nativeImage } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');

const [src, out, sizeArg] = process.argv.slice(-3);
const size = Number(sizeArg) || 40;

app.whenReady().then(() => {
  try {
    const img = nativeImage.createFromPath(src);
    if (img.isEmpty()) throw new Error(`cannot read ${src}`);
    const png = img.resize({ width: size, height: size, quality: 'best' }).toPNG();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, png);
    console.log(`logo ${size}x${size} -> ${out} (${png.length} bytes)`);
    app.exit(0);
  } catch (e) {
    console.error(`make-logo failed: ${e instanceof Error ? e.message : String(e)}`);
    app.exit(1);
  }
});
