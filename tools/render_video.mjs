#!/usr/bin/env node
// render_video.mjs — render a Pulse version to a vertical MP4 for social posts.
//
//   node render_video.mjs <variant> <out.mp4> [--seconds 20] [--year 2025]
//        [--reel]            the TikTok / Reels cut: no controls, self-explaining overlay
//        [--start-hour 6]    hour of the week the video opens on (0 = Mon midnight)
//   PULSE_URL overrides the site (default: the local server, http://127.0.0.1:8767)
//
// Why frame-stepped rather than screen-recorded: headless Chromium draws WebGL in
// software at a few frames a second, so a screen recording would stutter. Instead the
// page runs in ?capture=1 mode, and this script advances the week by a fixed amount per
// video frame through window.__pulse.step, giving the sphere smoothing exactly the
// updates live playback at ½× and 60 fps would have given it. The result is one full
// Monday-to-Sunday week, perfectly smooth, however slowly it renders.
//
// Needs: the Playwright Chromium in internal/ms-playwright (or CHROME=...), and an ffmpeg with
// libx264 (FFMPEG env var, e.g. the imageio-ffmpeg static build).
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [variant, out] = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
if (!variant || !out) { console.error('usage: render_video.mjs <variant> <out.mp4>'); process.exit(2); }
const SECONDS = +opt('--seconds', 20), FPS = 30, YEAR = opt('--year', '2025');
const REEL = args.includes('--reel'), START = +opt('--start-hour', REEL ? 6 : 0);
const BASE = process.env.PULSE_URL || 'http://127.0.0.1:8767';
const FRAMES = SECONDS * FPS;
const W = 432, H = 768, DPR = 2.5;            // 1080 x 1920, TikTok / Reels / Shorts
const WEEK = 168;
const PER_FRAME = WEEK / FRAMES;              // hours of the week per video frame (mean)

// Hours advanced on each video frame. Flat for the ordinary cut. The reel slows to a
// third of the pace through weekday rush hours, so its caption is on screen long enough
// to read (~1.3 s instead of ~0.4 s), and makes the time back everywhere else.
const RUSH_H = [[6.5, 10.5], [15.5, 19.5]], SLOW = 3.3;
const weight = (t) => { const d = Math.floor(t / 24) % 7, h = t % 24;
  return REEL && d < 5 && RUSH_H.some(([a, b]) => h >= a && h < b) ? SLOW : 1; };
const STEPS = (() => {
  if (!REEL) return Array(FRAMES).fill(PER_FRAME);
  const fine = 1 / 60, w = []; let total = 0;
  for (let t = 0; t < WEEK; t += fine) { const x = weight((START + t) % WEEK); w.push(x); total += x; }
  const perFrame = total / FRAMES, out = []; let acc = 0, hrs = 0;
  for (const x of w) { acc += x; hrs += fine; if (acc >= perFrame) { out.push(hrs); acc -= perFrame; hrs = 0; } }
  while (out.length < FRAMES) out.push(PER_FRAME);
  return out.slice(0, FRAMES);
})();
// Smoothing updates per video frame. The sphere EMA (alpha 0.07) has a time constant of
// ~14 updates; at 2 per frame that trails the clock by ~2 hours, so a reel caption saying
// "downtown fills up" would sit over a still-red core. 8 per frame brings the lag to
// ~30 min (~8 min inside the slowed rush windows). Updates are cheap; screenshots are not.
const SUB = REEL ? 8 : 2;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), '.cache', 'ms-playwright');   // Playwright's browser cache
  for (const d of readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse())
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const p = join(base, d, sub, 'chrome'); if (existsSync(p)) return p;
    }
  throw new Error('no chromium');
}

const frames = mkdtempSync(join(process.env.FRAMES_DIR || tmpdir(), 'pulse-frames-'));
// Chrome's profile needs a SHORT path: its singleton socket fails past ~107 characters.
const profile = mkdtempSync('/tmp/pp-');
const port = 9800 + Math.floor(Math.random() * 150);
const chrome = spawn(findChrome(), ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

try {
  let target;
  for (let t = 0; t < 50 && !target; t++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page'); } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true });
  await send('Page.navigate', { url: `${BASE}/v/${variant}/?${REEL ? 'reel' : 'capture'}=1&year=${YEAR}&cb=${Date.now()}` });

  for (let i = 0; i < 120 && !(await evaluate('!!(window.__pulse && window.__pulse.ready)')); i++) await sleep(250);
  if (!(await evaluate('!!(window.__pulse && window.__pulse.ready)'))) throw new Error('page never reached capture mode');
  await sleep(4000);                                              // let map tiles finish

  // Warm the smoothing up over the last 28 hours of Sunday so Monday 00:00 starts settled.
  const warm = Math.round(28 / (PER_FRAME / SUB));
  await evaluate(`window.__pulse.setT(${(START + WEEK - warm * (PER_FRAME / SUB)) % WEEK}); true`);
  await evaluate(`(async()=>{ for(let i=0;i<${warm};i+=50) await window.__pulse.step(${PER_FRAME / SUB}, Math.min(50, ${warm}-i)); return true })()`);
  await evaluate(`window.__pulse.setT(${(START + WEEK - STEPS[0]) % WEEK + 1e-6}); true`);   // first frame lands on START

  const t0 = Date.now();
  for (let f = 0; f < FRAMES; f++) {
    const lbl = await evaluate(`window.__pulse.step(${STEPS[f] / SUB}, ${SUB})`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(frames, `f${String(f).padStart(4, '0')}.png`), Buffer.from(shot.data, 'base64'));
    if (f % 60 === 0) console.log(`frame ${f}/${FRAMES}  ${lbl}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
} finally {
  try { ws && ws.close(); } catch {}
  chrome.kill('SIGKILL');
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}

const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, 'f%04d.png'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', out], { stdio: 'inherit' });
if (r.status !== 0) { console.error(`ffmpeg failed; frames kept in ${frames}`); process.exit(1); }
rmSync(frames, { recursive: true, force: true });
console.log('wrote', out);
