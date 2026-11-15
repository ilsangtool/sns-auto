// posts.json의 card 문구로 1080×1350 JPG 카드 이미지를 만든다 (이미 있으면 건너뜀)
// 디자인은 글마다 하나만 쓴다: card.design 'A'(에디토리얼) 또는 'B'(버건디 색면)

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const config = JSON.parse(await fs.readFile('config.json', 'utf8'));
const posts = JSON.parse(await fs.readFile('posts.json', 'utf8'));
const TEMPLATES = {
  A: await fs.readFile('templates/card-a.html', 'utf8'),
  B: await fs.readFile('templates/card-b.html', 'utf8'),
};
const OUT = 'images';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const todo = posts.filter((p) => p.card && p.images?.[0] && !existsSync(`${OUT}/${p.images[0]}`) && !p.result);
if (!todo.length) { console.log('새로 만들 카드 없음'); process.exit(0); }

await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });

for (const p of todo) {
  const c = p.card;
  const template = TEMPLATES[c.design] || TEMPLATES.A;
  const html = template
    .replaceAll('{{cat}}', esc(c.cat || ''))
    .replaceAll('{{brand}}', esc(config.brand || '일상툴'))
    .replaceAll('{{cta}}', esc(config.card_cta || '프로필 링크에서 무료로 써보세요'))
    .replaceAll('{{cta_sub}}', esc(config.card_cta_sub || '→'))
    .replaceAll('{{app}}', esc(c.app || p.app))
    .replaceAll('{{headline}}', esc(c.headline))
    .replaceAll('{{sub}}', esc(c.sub))
    .replaceAll('{{points}}', (c.points || []).map((t, i) => `<li><em>0${i + 1}</em><span>${esc(t)}</span></li>`).join(''));

  await page.setContent(html, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);

  // 제목이 넘치면 글자 크기를 줄여 맞춤
  await page.evaluate(() => {
    const main = document.querySelector('.main'), h1 = document.querySelector('h1');
    let size = parseFloat(getComputedStyle(h1).fontSize);
    while (main.scrollHeight > main.clientHeight && size > 60) { size -= 4; h1.style.fontSize = size + 'px'; }
  });

  const file = `${OUT}/${p.images[0]}`;
  await page.screenshot({ path: file, type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: 1080, height: 1350 } });
  console.log(`🖼️  ${file} (디자인 ${c.design || 'A'})`);
}

await browser.close();
