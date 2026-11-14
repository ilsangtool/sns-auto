// 인스타그램 · 스레드 예약 게시 스크립트 (Node 20+, 외부 패키지 없음)
// posts.json에서 게시 시각이 지난 글을 골라 두 플랫폼에 올리고 결과를 다시 기록한다.

import fs from 'node:fs/promises';

const env = process.env;
const POSTS_FILE = env.POSTS_FILE || 'posts.json';
const DRY_RUN = env.DRY_RUN === 'true';
const MAX_PER_RUN = Number(env.MAX_PER_RUN || 1);   // 한 번 실행에 올릴 글 수 (도배 방지)
const MAX_ATTEMPTS = 3;                              // 실패 시 재시도 횟수

const IG = {
  token: env.IG_ACCESS_TOKEN,
  user: env.IG_USER_ID || 'me',
  base: `https://graph.instagram.com/${env.IG_API_VERSION || 'v25.0'}`,
};
const TH = {
  token: env.THREADS_ACCESS_TOKEN,
  user: env.THREADS_USER_ID || 'me',
  base: 'https://graph.threads.net/v1.0',
};
const IMAGE_BASE_URL = (env.IMAGE_BASE_URL || '').replace(/\/$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, params) {
  const qs = new URLSearchParams(params);
  const res = method === 'GET'
    ? await fetch(`${url}?${qs}`)
    : await fetch(url, { method, body: qs });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || data;
    throw new Error(`[${res.status}] ${e.message || JSON.stringify(e)}`);
  }
  return data;
}

function imageUrl(name) {
  if (/^https?:\/\//.test(name)) return name;
  if (!IMAGE_BASE_URL) throw new Error('IMAGE_BASE_URL 변수가 비어 있습니다');
  return `${IMAGE_BASE_URL}/${encodeURI(name)}`;
}

// 컨테이너(업로드 대기 객체)가 처리 완료될 때까지 대기
async function waitReady(base, token, id, field) {
  for (let i = 0; i < 20; i++) {
    const d = await call('GET', `${base}/${id}`, { fields: field, access_token: token });
    const s = d[field];
    if (s === 'FINISHED') return;
    if (s === 'ERROR' || s === 'EXPIRED') throw new Error(`컨테이너 처리 실패: ${s}`);
    await sleep(5000);
  }
  throw new Error('컨테이너 처리 시간 초과');
}

// ───────── 인스타그램 ─────────
async function publishInstagram(post) {
  if (!IG.token) throw new Error('IG_ACCESS_TOKEN 없음');
  const images = post.images || [];
  if (images.length === 0) throw new Error('인스타그램은 이미지가 1장 이상 필요합니다');
  if (images.some((n) => !/\.jpe?g$/i.test(n))) throw new Error('인스타그램 API는 JPEG 이미지만 받습니다');
  const caption = post.instagram_caption || post.threads_text;
  const t = IG.token;
  const mediaUrl = `${IG.base}/${IG.user}/media`;

  let containerId;
  if (images.length === 1) {
    ({ id: containerId } = await call('POST', mediaUrl, { image_url: imageUrl(images[0]), caption, access_token: t }));
  } else {
    const children = [];
    for (const img of images.slice(0, 10)) {
      const { id } = await call('POST', mediaUrl, { image_url: imageUrl(img), is_carousel_item: 'true', access_token: t });
      await waitReady(IG.base, t, id, 'status_code');
      children.push(id);
    }
    ({ id: containerId } = await call('POST', mediaUrl, { media_type: 'CAROUSEL', children: children.join(','), caption, access_token: t }));
  }
  await waitReady(IG.base, t, containerId, 'status_code');
  const { id } = await call('POST', `${IG.base}/${IG.user}/media_publish`, { creation_id: containerId, access_token: t });
  return id;
}

// ───────── 스레드 ─────────
async function publishThreads(post) {
  if (!TH.token) throw new Error('THREADS_ACCESS_TOKEN 없음');
  const text = post.threads_text || '';
  if ([...text].length > 500) throw new Error(`스레드 본문이 500자를 넘습니다 (${[...text].length}자)`);
  const images = post.images || [];
  const t = TH.token;
  const url = `${TH.base}/${TH.user}/threads`;

  let params;
  if (images.length === 0) {
    params = { media_type: 'TEXT', text };
    if (post.link) params.link_attachment = post.link;   // 링크 미리보기 카드
  } else if (images.length === 1) {
    params = { media_type: 'IMAGE', image_url: imageUrl(images[0]), text };
  } else {
    const children = [];
    for (const img of images.slice(0, 20)) {
      const { id } = await call('POST', url, { media_type: 'IMAGE', image_url: imageUrl(img), is_carousel_item: 'true', access_token: t });
      children.push(id);
    }
    params = { media_type: 'CAROUSEL', children: children.join(','), text };
  }
  const { id: containerId } = await call('POST', url, { ...params, access_token: t });
  await waitReady(TH.base, t, containerId, 'status');
  const { id } = await call('POST', `${TH.base}/${TH.user}/threads_publish`, { creation_id: containerId, access_token: t });
  return id;
}

const PUBLISHERS = { instagram: publishInstagram, threads: publishThreads };

// ───────── 메인 ─────────
const posts = JSON.parse(await fs.readFile(POSTS_FILE, 'utf8'));
const now = Date.now();

const isPending = (p, platform) => {
  const r = p.result?.[platform];
  return !r || r.status === 'pending';
};

const due = posts
  .filter((p) => !p.paused && new Date(p.scheduled_at).getTime() <= now)
  .filter((p) => (p.platforms || []).some((pl) => isPending(p, pl)))
  .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))
  .slice(0, MAX_PER_RUN);

if (due.length === 0) {
  console.log('게시할 글 없음');
  process.exit(0);
}

// 이미지가 Pages에 실제로 배포됐는지 확인 (배포 전이면 다음 실행 때 다시 시도, 실패 횟수에 넣지 않음)
async function imagesReady(post) {
  for (const img of post.images || []) {
    try {
      const res = await fetch(imageUrl(img), { method: 'HEAD' });
      if (!res.ok) return false;
    } catch { return false; }
  }
  return true;
}

let failed = false;
for (const post of due) {
  post.result ??= {};
  if (!DRY_RUN && !(await imagesReady(post))) {
    console.log(`⏳ ${post.id} 이미지가 아직 배포되지 않아 다음 실행으로 미룸`);
    continue;
  }
  for (const platform of post.platforms) {
    if (!isPending(post, platform)) continue;
    const fn = PUBLISHERS[platform];
    if (!fn) { console.log(`⚠️ 지원하지 않는 플랫폼: ${platform}`); continue; }

    if (DRY_RUN) {
      console.log(`🧪 [미리보기] ${post.id} → ${platform}\n${platform === 'instagram' ? post.instagram_caption : post.threads_text}\n이미지: ${(post.images || []).map((n) => imageUrl(n)).join(', ') || '없음'}\n`);
      continue;
    }

    const prev = post.result[platform] || { attempts: 0 };
    try {
      const id = await fn(post);
      post.result[platform] = { status: 'published', id, published_at: new Date().toISOString() };
      console.log(`✅ ${post.id} → ${platform} 게시 완료 (${id})`);
    } catch (err) {
      const attempts = (prev.attempts || 0) + 1;
      post.result[platform] = {
        status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
        attempts,
        last_error: String(err.message).slice(0, 300),
      };
      console.error(`❌ ${post.id} → ${platform} 실패 (${attempts}/${MAX_ATTEMPTS}): ${err.message}`);
      failed = true;
    }
  }
}

if (!DRY_RUN) await fs.writeFile(POSTS_FILE, JSON.stringify(posts, null, 2) + '\n');
if (failed) process.exitCode = 1;   // 실패 시 GitHub이 메일로 알림
