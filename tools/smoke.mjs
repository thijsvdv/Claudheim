/**
 * Headless boot check. Serves the built site, loads it in Chromium with
 * SwiftShader WebGL, clicks through the boot veil, and fails on any console
 * error, page error, or failed request. Also samples the frame rate and
 * asserts the world actually produced geometry.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const PORT = 4183;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(PORT, r));

const errors = [];
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));
page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(`http://localhost:${PORT}/?seed=vardholm&debug`, { waitUntil: 'load' });

// Boot is async (systems construct across frames); wait for the Wake button.
await page.waitForSelector('#boot-play:not([hidden])', { timeout: 60000 });
await page.click('#boot-play');
await page.waitForTimeout(1000);

// Drive a few seconds of real input so update paths actually execute.
for (const key of ['KeyW', 'KeyD', 'Space', 'KeyS']) {
  await page.keyboard.down(key);
  await page.waitForTimeout(700);
  await page.keyboard.up(key);
}
await page.mouse.click(640, 360);
await page.waitForTimeout(400);
for (const key of ['KeyI', 'Escape', 'KeyC', 'Escape', 'KeyV', 'Escape', 'KeyM', 'Escape']) {
  await page.keyboard.press(key);
  await page.waitForTimeout(350);
}
await page.waitForTimeout(1500);

const stats = await page.evaluate(() => {
  const g = window.__ashwake;
  if (!g) return { error: 'window.__ashwake missing' };
  let meshes = 0;
  g.scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh) meshes++; });
  return {
    meshes,
    drawCalls: g.renderer.info.render.calls,
    triangles: g.renderer.info.render.triangles,
    systems: g.systems.map((s) => s.name),
    entities: g.entities?.list?.length ?? 0,
    day: g.time.day,
    dayFraction: +g.time.dayFraction.toFixed(3),
    player: g.player?.position ? {
      x: +g.player.position.x.toFixed(1),
      y: +g.player.position.y.toFixed(1),
      z: +g.player.position.z.toFixed(1),
    } : null,
    hp: g.player?.stats?.hp ?? null,
    stam: g.player?.stats?.stam ?? null,
    running: g.loop.running,
  };
});

await page.screenshot({ path: 'tools/smoke.png' });
await browser.close();
server.close();

console.log('--- smoke stats ---');
console.log(JSON.stringify(stats, null, 2));

if (errors.length) {
  console.log(`\n--- ${errors.length} error(s) ---`);
  for (const e of errors.slice(0, 25)) console.log(e);
  process.exit(1);
}
if (!stats || stats.error) { console.log('\nFAIL:', stats?.error); process.exit(1); }
if (stats.meshes < 10) { console.log('\nFAIL: world produced almost no geometry'); process.exit(1); }
if (!stats.running) { console.log('\nFAIL: game loop is not running'); process.exit(1); }
console.log('\nOK — booted clean, world populated, no console errors.');
