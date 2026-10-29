// assets/icon.svg → out/icon/icon.ico (16·24·32·48·64·128·256 PNG를 담은 ICO). 새 의존성 없이 Electron 오프스크린 창으로 렌더한다.
// 실행: electron scripts/make-icon.cjs (npm run dist가 호출). ICO 안 PNG 형식은 Windows Vista 이상에서 지원.
const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** PNG 버퍼 목록으로 ICO 파일을 만든다(헤더 6 + 항목 16×n + PNG 데이터). */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = 아이콘
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 = 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

// Electron 기본 userData(%APPDATA%\Electron)에 흔적이 남지 않게 out/ 아래를 쓴다
app.setPath('userData', join(root, 'out', 'icon-userdata'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const svg = readFileSync(join(root, 'assets', 'icon.svg'), 'utf8');
    const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
    const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="256" height="256" ')}</body></html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
    if (img.isEmpty()) throw new Error('icon render failed (empty image)');
    const pngs = SIZES.map((size) => ({ size, data: (size === 256 ? img : img.resize({ width: size, height: size, quality: 'best' })).toPNG() }));
    const outDir = join(root, 'out', 'icon');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'icon.ico'), buildIco(pngs));
    writeFileSync(join(outDir, 'icon-256.png'), pngs[pngs.length - 1].data);
    console.log(`icon ok -> ${join(outDir, 'icon.ico')} (${SIZES.join(', ')})`);
    app.exit(0);
  } catch (e) {
    console.error(`icon failed: ${e && e.message ? e.message : e}`);
    app.exit(1);
  }
});
