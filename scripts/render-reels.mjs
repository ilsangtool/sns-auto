// posts.json의 reel 문구로 1080×1920 세로 MP4(릴스·스레드 영상)를 만든다 (이미 있으면 건너뜀)
// 화면을 프레임 단위로 캡처해 FFmpeg로 H.264 + AAC MP4로 묶는다. 외부 사이트는 열지 않는다.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const config = JSON.parse(await fs.readFile('config.json', 'utf8'));
const posts = JSON.parse(await fs.readFile('posts.json', 'utf8'));
const template = await fs.readFile('templates/reel.html', 'utf8');
const OUT = 'images';
const FPS = Number(process.env.REEL_FPS || 30);
const ONLY = process.env.ONLY_ID || '';               // 특정 글만 다시 만들 때

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const todo = posts.filter((p) => p.reel && p.video && !p.result && (ONLY ? p.id === ONLY : !existsSync(`${OUT}/${p.video}`)));
if (!todo.length) { console.log('새로 만들 릴스 없음'); process.exit(0); }

await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });

// 외부 요청 차단: 폰트 CDN만 허용
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith('data:') || u.startsWith('about:') || u.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard')) return route.continue();
  return route.abort();
});

function ffmpeg(file, seconds) {
  const args = [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-r', String(FPS), '-g', String(FPS * 2),
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', file,
  ];
  const p = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => p.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg 종료 코드 ${code}`)))));
  return { stdin: p.stdin, done };
}

const write = (stream, buf) => new Promise((res) => (stream.write(buf) ? res() : stream.once('drain', res)));

for (const p of todo) {
  const r = p.reel;
  const data = JSON.stringify({ app: r.app || p.app, hook: r.hook, steps: r.steps, outro: r.outro, badge: r.badge || '' }).replace(/</g, '\\u003c');
  const html = template
    .replaceAll('{{cat}}', esc(r.cat || ''))
    .replaceAll('{{brand}}', esc(config.brand || '일상툴'))
    .replaceAll('{{cta}}', esc(config.card_cta || '프로필 링크에서 무료로 써보세요'))
    .replaceAll('{{cta_sub}}', esc(config.card_cta_sub || '→'))
    .replace('{{data}}', () => data);

  await page.setContent(html, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => window.DURATION);
  const frames = Math.round(duration * FPS);

  const file = `${OUT}/${p.video}`;
  const enc = ffmpeg(file, duration);
  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
    await write(enc.stdin, buf);
  }
  enc.stdin.end();
  await enc.done;
  const { size } = await fs.stat(file);
  console.log(`🎬 ${file}  ${duration.toFixed(1)}초 · ${(size / 1048576).toFixed(1)}MB · ${((Date.now() - t0) / 1000).toFixed(0)}초 소요`);
}

await browser.close();
