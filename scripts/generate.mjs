// 다음 주 홍보글 자동 생성 (Claude API) → posts.json에 추가
// 일정·앱 배정은 코드가 하고, Claude는 글과 카드 문구만 쓴다.

import fs from 'node:fs/promises';

const env = process.env;
const API_KEY = env.ANTHROPIC_API_KEY;
const FORCE = env.FORCE === 'true';
const DRY_RUN = env.DRY_RUN === 'true';

const config = JSON.parse(await fs.readFile('config.json', 'utf8'));
const apps = JSON.parse(await fs.readFile('apps.json', 'utf8')).filter((a) => a.active !== false);
const posts = JSON.parse(await fs.readFile('posts.json', 'utf8'));
const system = await fs.readFile('prompts/system.md', 'utf8');
const MODEL = env.ANTHROPIC_MODEL || config.model || 'claude-sonnet-5-5';

if (!apps.length) { console.log('apps.json에 활성 앱이 없습니다'); process.exit(0); }

// ───────── 1. 대상 주간 계산 (한국시간) ─────────
const KST = 9 * 3600e3;
const DAY = 86400e3;
const DAYS = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const nowKst = new Date(Date.now() + KST);
const dow = nowKst.getUTCDay();
const toMon = env.WEEK === 'this' ? -((dow + 6) % 7) : ((8 - dow) % 7 || 7);
const monKst = new Date(Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate() + toMon));
const ymd = (d) => d.toISOString().slice(0, 10);
const weekKey = ymd(monKst);

if (!FORCE && posts.some((p) => p.week === weekKey)) {
  console.log(`${weekKey} 주간 글이 이미 있습니다 (다시 만들려면 FORCE=true)`);
  process.exit(0);
}

// 주차 번호로 앱 순환 → 매주 다른 앱부터 시작
const weekNo = Math.floor(monKst.getTime() / (7 * DAY));
const slots = config.slots
  .map((s, i) => {
    const offset = (DAYS[s.day] + 6) % 7;                 // 월=0 … 일=6
    const date = new Date(monKst.getTime() + offset * DAY);
    const at = `${ymd(date)}T${s.time}:00+09:00`;
    const app = apps[(weekNo + i) % apps.length];
    return { ...s, at, app, id: `${ymd(date)}-${app.slug}-${i + 1}` };
  })
  .filter((s) => new Date(s.at).getTime() > Date.now() + 30 * 60e3)   // 이미 지난 시간대 제외
  .sort((a, b) => new Date(a.at) - new Date(b.at));

if (!slots.length) { console.log('남은 게시 시간대가 없습니다'); process.exit(0); }

// ───────── 2. 앱 페이지 내용 수집 (기능 설명 보강용) ─────────
async function pageText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    return html
      .replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2500);
  } catch { return ''; }
}

const usedApps = [...new Map(slots.map((s) => [s.app.slug, s.app])).values()];
const appInfo = [];
for (const a of usedApps) {
  appInfo.push({
    slug: a.slug, name: a.name, target: a.target, problem: a.problem, features: a.features,
    page_text: await pageText(a.url),
  });
}

const recent = posts.slice(-12).map((p) => p.threads_text).filter(Boolean);

// ───────── 같은 내용 재게시 방지 ─────────
// 띄어쓰기·문장부호·이모지를 지운 글자로 비교한다. 이전에 쓴 본문·제목·첫 장면과 같으면 다시 쓰게 한다.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
const pastTexts = new Set(posts.map((p) => norm(p.threads_text)).filter(Boolean));
const pastHeads = new Set(posts.flatMap((p) => [p.card?.headline, p.reel?.hook]).map(norm).filter(Boolean));
const usedHeads = [...new Set(posts.slice(-60).flatMap((p) => [p.card?.headline, p.reel?.hook]).filter(Boolean))];

// ───────── 3. Claude 호출 ─────────
const request = {
  apps: appInfo,
  recent_posts: recent,
  used_headlines: usedHeads,
  slots: slots.map((s, i) => ({ index: i, app: s.app.slug, type: s.type, with_image: !!s.image && !s.video, with_video: !!s.video })),
};

const userPrompt = `아래 JSON의 slots 순서 그대로 게시글을 만들어라.
with_image가 true면 threads_text, instagram_caption, card를 쓰고(reel은 null),
with_video가 true면 threads_text, instagram_caption, reel을 쓰고(card는 null),
둘 다 false면 threads_text만 쓴다(instagram_caption, card, reel은 null).
recent_posts와 used_headlines에 이미 쓴 글·제목과 같거나 거의 같은 문장은 쓰지 마라. 같은 내용은 한 번만 게시한다.

출력은 설명 없이 JSON 배열 하나만:
[{"index":0,"threads_text":"...","instagram_caption":"..." 또는 null,
  "card":{"headline":"...","sub":"...","points":["...","...","..."]} 또는 null,
  "reel":{"hook":"...","steps":[{"title":"...","desc":"..."},{"title":"...","desc":"..."},{"title":"...","desc":"..."}],"outro":"..."} 또는 null}]

입력:
${JSON.stringify(request, null, 2)}`;

async function askClaude(messages) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY 없음');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, system, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API 오류 [${res.status}] ${data.error?.message || JSON.stringify(data)}`);
  return data.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
}

function parse(text) {
  const s = text.indexOf('['), e = text.lastIndexOf(']');
  if (s < 0 || e < 0) throw new Error('JSON 배열을 찾지 못함');
  return JSON.parse(text.slice(s, e + 1));
}

function validate(items) {
  const problems = [];
  slots.forEach((slot, i) => {
    const it = items.find((x) => x.index === i);
    if (!it) return problems.push(`index ${i}: 누락`);
    const len = [...(it.threads_text || '')].length;
    const head = it.card?.headline || it.reel?.hook;
    if (pastTexts.has(norm(it.threads_text))) problems.push(`index ${i}: threads_text가 이전 글과 같음 (새로 써야 함)`);
    if (head && pastHeads.has(norm(head))) problems.push(`index ${i}: 제목(${head})이 이전 글과 같음 (새로 써야 함)`);
    if (items.some((x) => x !== it && norm(x.threads_text) === norm(it.threads_text))) problems.push(`index ${i}: 같은 주 다른 글과 본문이 같음`);
    if (len < 20 || len > 500) problems.push(`index ${i}: threads_text 길이 ${len}자 (20~500자)`);
    if (/https?:\/\//.test(it.threads_text || '')) problems.push(`index ${i}: threads_text에 URL 포함`);
    if (slot.video) {
      if (!it.instagram_caption) problems.push(`index ${i}: instagram_caption 누락`);
      const r = it.reel;
      if (!r?.hook || !r?.outro || !Array.isArray(r.steps) || r.steps.length !== 3 || r.steps.some((x) => !x?.title || !x?.desc))
        problems.push(`index ${i}: reel 형식 오류`);
      else {
        if ([...r.hook].length > 24) problems.push(`index ${i}: reel.hook이 너무 김 (24자 이내)`);
        if ([...r.outro].length > 22) problems.push(`index ${i}: reel.outro가 너무 김 (22자 이내)`);
        r.steps.forEach((x, k) => {
          if ([...x.title].length > 16) problems.push(`index ${i}: reel.steps[${k}].title이 너무 김 (16자 이내)`);
          if ([...x.desc].length > 30) problems.push(`index ${i}: reel.steps[${k}].desc가 너무 김 (30자 이내)`);
        });
      }
    } else if (slot.image) {
      if (!it.instagram_caption) problems.push(`index ${i}: instagram_caption 누락`);
      const c = it.card;
      if (!c?.headline || !c?.sub || !Array.isArray(c.points) || c.points.length !== 3)
        problems.push(`index ${i}: card 형식 오류`);
      else if ([...c.headline].length > 28) problems.push(`index ${i}: headline이 너무 김`);
    }
  });
  return problems;
}

const messages = [{ role: 'user', content: userPrompt }];
let items, problems = ['미실행'];
for (let attempt = 1; attempt <= 3 && problems.length; attempt++) {
  const text = await askClaude(messages);
  try {
    items = parse(text);
    problems = validate(items);
  } catch (err) {
    problems = [err.message];
  }
  if (problems.length) {
    console.log(`⚠️ ${attempt}차 생성 결과 수정 필요:\n- ${problems.join('\n- ')}`);
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: `다음 문제를 고쳐서 전체 JSON 배열을 다시 출력해라:\n- ${problems.join('\n- ')}` });
  }
}
if (problems.length) throw new Error('3회 시도 후에도 형식이 맞지 않아 중단합니다');

// ───────── 4. posts.json에 추가 ─────────
// 카드 디자인은 글마다 하나만: 지금까지 만든 카드 수를 이어 세어 A·B를 번갈아 쓴다
let cardNo = posts.filter((p) => p.card).length;
const newPosts = slots.map((slot, i) => {
  const it = items.find((x) => x.index === i);
  const post = {
    id: slot.id,
    week: weekKey,
    scheduled_at: slot.at,
    app: slot.app.name,
    type: slot.type,
    platforms: slot.image || slot.video ? ['threads', 'instagram'] : ['threads'],
    threads_text: it.threads_text.trim(),
    link: slot.app.url,
    images: [],
  };
  if (slot.video) {
    post.instagram_caption = it.instagram_caption.trim();
    // 마지막 장면 배지는 apps.json의 장점(사실)에서만 가져온다
    const badge = (slot.app.features || []).filter((f) => [...f].length <= 8).slice(0, 2).join(' · ');
    post.reel = { ...it.reel, app: slot.app.name, cat: slot.app.category || '', badge };
    post.video = `${slot.id}.mp4`;
  } else if (slot.image) {
    post.instagram_caption = it.instagram_caption.trim();
    post.card = { ...it.card, app: slot.app.name, cat: slot.app.category || '', design: cardNo++ % 2 === 0 ? 'A' : 'B' };
    post.images = [`${slot.id}.jpg`];
  }
  if (!config.auto_approve) post.paused = true;
  return post;
});

if (DRY_RUN) {
  console.log(JSON.stringify(newPosts, null, 2));
} else {
  const kept = FORCE ? posts.filter((p) => p.week !== weekKey || p.result) : posts;
  await fs.writeFile('posts.json', JSON.stringify([...kept, ...newPosts], null, 2) + '\n');
  console.log(`✅ ${weekKey} 주간 글 ${newPosts.length}개 생성`);
  newPosts.forEach((p) => console.log(`  ${p.scheduled_at}  [${p.type}] ${p.app}  ${p.platforms.join('+')}${p.card ? `  카드 ${p.card.design}` : p.reel ? '  릴스' : ''}`));
}
