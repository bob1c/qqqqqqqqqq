'use strict';
// MemePulse: real-time meme/news radar for memecoin hunting.
// Zero dependencies. Node 18+.  Run: node server.js   (then open http://localhost:3000)
 
const http = require('http');
const fs = require('fs');
const path = require('path');
 
const PORT = Number(process.env.PORT || 3000);
const UA = 'Mozilla/5.0 (compatible; MemePulse/1.0)';
const MAX_AGE_H = 36;
 
const items = new Map();   // id -> item
const status = {};         // source -> {ok, last, count, error}
const coinCache = new Map(); // ticker -> {t, data}
const clients = new Set();
 
/* ----------------------------- helpers ----------------------------- */
async function getText(url, headers = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
async function getJSON(url, headers) { return JSON.parse(await getText(url, headers)); }
const now = () => Date.now();
const ageH = (ts) => Math.max(0, (now() - ts) / 3600000);
const clean = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
 
function upsert(it) {
  const old = items.get(it.id);
  const t = now();
  // Keep a short history of the score so we can measure how fast a post is growing.
  const hist = ((old && old.hist) || []).concat([[t, it.score]]).slice(-40);
  items.set(it.id, { ...(old || {}), ...it, hist, firstSeen: old ? old.firstSeen : t });
}
 
// Growth over the last ~30-90 minutes, based on what we observed ourselves.
function growth(it) {
  const t = now();
  const past = (it.hist || []).filter(([ts]) => t - ts >= 25 * 60000 && t - ts <= 100 * 60000);
  if (!past.length) return null;
  const [ts, sc] = past[0];
  const delta = it.score - sc;
  return { delta, base: Math.max(sc, 1), perHour: delta / ((t - ts) / 3600000) };
}
 
/* ----------------------------- sources ----------------------------- */
// Each source returns an array of {id, source, kind, title, url, image, author, ts, score, comments, extra}
 
const SUBS = (process.env.SUBREDDITS ||
  'all,popular,memes,dankmemes,MemeEconomy,wholesomememes,me_irl,OutOfTheLoop,worldnews,news,technology,todayilearned,interestingasfuck,nextfuckinglevel,Cryptocurrency,solana').split(',');
const MEME_SUBS = new Set(['memes', 'dankmemes', 'MemeEconomy', 'wholesomememes', 'me_irl', 'interestingasfuck', 'nextfuckinglevel']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
 
// Reddit often blocks datacenter IPs on one host but not another, so try several routes per subreddit.
async function redditSub(sub) {
  const urls = [
    `https://www.reddit.com/r/${sub}/rising.json?limit=25&raw_json=1`,
    `https://old.reddit.com/r/${sub}/rising.json?limit=25&raw_json=1`,
    `https://www.reddit.com/r/${sub}/hot.json?limit=25&raw_json=1`,
  ];
  let lastErr;
  for (const u of urls) {
    try { return (await getJSON(u)).data.children; } catch (e) { lastErr = e; }
  }
  // Last resort: RSS (no vote counts, so rank by position in the feed).
  try {
    const xml = await getText(`https://www.reddit.com/r/${sub}/hot.rss?limit=25`);
    const out = [];
    let n = 0;
    for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const b = m[1];
      const link = (b.match(/<link href="([^"]+)"/) || [])[1];
      const title = clean((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
      const upd = (b.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1];
      const id = (b.match(/<id>t3_([a-z0-9]+)<\/id>/) || [])[1];
      if (!link || !title) continue;
      out.push({ data: { id: id || link, title, permalink: link.replace('https://www.reddit.com', ''), created_utc: Date.parse(upd) / 1000, score: Math.max(10, 500 - 20 * n), num_comments: 20, stickied: false, over_18: false } });
      n++;
    }
    if (out.length) return out;
  } catch (e) { lastErr = e; }
  throw lastErr || new Error('reddit blocked');
}
 
async function srcReddit() {
  const out = [];
  let fails = 0, lastErr;
  for (const sub of SUBS) {
    await sleep(250);
    let children;
    try { children = await redditSub(sub); } catch (e) { fails++; lastErr = e; continue; }
    for (const c of children) {
      const d = c.data;
      if (d.stickied || d.over_18) continue;
      const img = d.post_hint === 'image' ? d.url : (d.thumbnail && d.thumbnail.startsWith('http') ? d.thumbnail : '');
      out.push({
        id: 'rd_' + d.id, source: 'reddit', kind: MEME_SUBS.has(sub) ? 'meme' : 'news',
        title: clean(d.title), url: 'https://reddit.com' + d.permalink, image: img, author: 'r/' + sub,
        ts: d.created_utc * 1000, score: d.score, comments: d.num_comments,
      });
    }
  }
  if (!out.length && fails) throw lastErr;
  return out;
}
 
const stripHtml = (s) => clean(String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<\/p>/gi, ' ').replace(/<[^>]+>/g, ''));
 
// Mastodon: public trending posts and links, no key needed.
async function srcMastodon() {
  const host = process.env.MASTODON_HOST || 'mastodon.social';
  const [posts, links] = await Promise.all([
    getJSON(`https://${host}/api/v1/trends/statuses?limit=40`).catch(() => []),
    getJSON(`https://${host}/api/v1/trends/links?limit=20`).catch(() => []),
  ]);
  if (!posts.length && !links.length) throw new Error('no data');
  const out = [];
  for (const p of posts) {
    const text = stripHtml(p.content);
    if (!text || p.sensitive) continue;
    const media = (p.media_attachments || []).find((m) => m.preview_url);
    out.push({
      id: 'ma_' + p.id, source: 'mastodon', kind: 'meme', title: text.slice(0, 220), url: p.url,
      image: media ? media.preview_url : '', author: '@' + (p.account && p.account.acct),
      ts: Date.parse(p.created_at), score: (p.favourites_count || 0) + 2 * (p.reblogs_count || 0), comments: p.replies_count || 0,
    });
  }
  for (const l of links) {
    const uses = (l.history || []).slice(0, 2).reduce((a, h) => a + Number(h.uses || 0), 0);
    out.push({
      id: 'ml_' + l.url, source: 'mastodon', kind: 'news', title: clean(l.title), url: l.url, image: l.image || '',
      author: l.provider_name || 'link', ts: Date.parse(l.published_at) || now(), score: uses * 20, comments: 0,
    });
  }
  return out;
}
 
// Bluesky: the public "What's Hot" feed, no key needed.
async function srcBluesky() {
  const feed = encodeURIComponent('at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot');
  const j = await getJSON(`https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=${feed}&limit=50`);
  const out = [];
  for (const f of j.feed || []) {
    const p = f.post;
    const text = clean(p.record && p.record.text);
    if (!text || (p.labels && p.labels.length)) continue;
    const img = p.embed && p.embed.images && p.embed.images[0] ? p.embed.images[0].thumb : (p.embed && p.embed.thumbnail) || '';
    out.push({
      id: 'bs_' + p.uri, source: 'bluesky', kind: 'meme', title: text.slice(0, 220),
      url: `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split('/').pop()}`, image: img,
      author: '@' + p.author.handle, ts: Date.parse(p.record.createdAt), score: (p.likeCount || 0) + 2 * (p.repostCount || 0), comments: p.replyCount || 0,
    });
  }
  return out;
}
 
async function srcHN() {
  const ids = (await getJSON('https://hacker-news.firebaseio.com/v0/topstories.json')).slice(0, 30);
  const out = [];
  await Promise.all(ids.map(async (id) => {
    try {
      const d = await getJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      if (!d || !d.title) return;
      out.push({
        id: 'hn_' + id, source: 'hackernews', kind: 'news', title: clean(d.title),
        url: d.url || `https://news.ycombinator.com/item?id=${id}`, image: '', author: d.by,
        ts: d.time * 1000, score: d.score, comments: d.descendants || 0,
      });
    } catch (_) { /* skip one item */ }
  }));
  return out;
}
 
async function srcTrends() {
  const xml = await getText('https://trends.google.com/trending/rss?geo=' + (process.env.TRENDS_GEO || 'US'));
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = clean((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const traffic = clean((b.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/) || [])[1]);
    const pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const news = clean((b.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/) || [])[1]);
    const link = clean((b.match(/<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/) || [])[1]);
    const n = parseInt(traffic.replace(/[^\d]/g, ''), 10) || 0;
    if (!title) continue;
    out.push({
      id: 'gt_' + title.toLowerCase(), source: 'trends', kind: 'trend',
      title: news ? `${title}: ${news}` : title, url: link || 'https://trends.google.com/trending?geo=US',
      image: '', author: traffic ? traffic + ' searches' : 'Google Trends',
      ts: pub ? Date.parse(pub) : now(), score: n / 100, comments: 0,
    });
  }
  return out;
}
 
// Tokens that are already trading right now (what the market is rewarding).
async function srcGecko() {
  const j = await getJSON('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token,dex&page=1');
  const inc = Object.fromEntries((j.included || []).map((x) => [x.type + ':' + x.id, x]));
  const out = [];
  for (const p of j.data || []) {
    const a = p.attributes;
    const dex = (p.relationships.dex.data || {}).id || '';
    if (!/pump/i.test(dex)) continue;
    const base = inc['token:' + (p.relationships.base_token.data || {}).id];
    const name = (a.name || '').split(' / ')[0];
    const created = Date.parse(a.pool_created_at);
    out.push({
      id: 'gk_' + p.id, source: 'pumpfun', kind: 'coin', title: name,
      url: 'https://www.geckoterminal.com/solana/pools/' + a.address,
      image: base && base.attributes ? base.attributes.image_url || '' : '',
      author: dex, ts: created || now(),
      score: Number(a.volume_usd && a.volume_usd.h1) / 100 || 0,
      comments: Number(a.transactions && a.transactions.h1 && a.transactions.h1.buys) || 0,
      extra: { mcap: Number(a.fdv_usd) || 0, change1h: Number(a.price_change_percentage && a.price_change_percentage.h1) || 0, vol1h: Number(a.volume_usd && a.volume_usd.h1) || 0 },
    });
  }
  return out;
}
 
// Fresh token profiles on Solana (projects that just paid for a profile = people are marketing them).
async function srcDexProfiles() {
  const j = await getJSON('https://api.dexscreener.com/token-profiles/latest/v1');
  const out = [];
  for (const p of j) {
    if (p.chainId !== 'solana') continue;
    const title = clean((p.description || '').slice(0, 90)) || p.tokenAddress.slice(0, 6);
    out.push({
      id: 'dx_' + p.tokenAddress, source: 'dexscreener', kind: 'coin', title,
      url: p.url, image: p.icon || '', author: 'new profile', ts: now(), score: 0, comments: (p.links || []).length,
    });
  }
  return out;
}
 
// Optional: X (Twitter) recent search. Needs a paid API plan. X_BEARER=... X_QUERY='...'
async function srcX() {
  if (!process.env.X_BEARER) return null;
  const q = encodeURIComponent(process.env.X_QUERY || '(meme OR viral OR "is cooked") -is:retweet lang:en has:images');
  const j = await getJSON(`https://api.x.com/2/tweets/search/recent?query=${q}&max_results=50&tweet.fields=public_metrics,created_at`,
    { Authorization: 'Bearer ' + process.env.X_BEARER });
  return (j.data || []).map((t) => ({
    id: 'x_' + t.id, source: 'x', kind: 'meme', title: clean(t.text), url: 'https://x.com/i/status/' + t.id,
    image: '', author: 'X', ts: Date.parse(t.created_at),
    score: t.public_metrics.like_count + 2 * t.public_metrics.retweet_count, comments: t.public_metrics.reply_count,
  }));
}
 
// Optional: TikTok through an Apify actor. APIFY_TOKEN=... APIFY_TIKTOK_ACTOR=user~actor-name
// Map the actor's output fields in the function below to match the actor you pick.
async function srcTikTok() {
  if (!process.env.APIFY_TOKEN || !process.env.APIFY_TIKTOK_ACTOR) return null;
  const url = `https://api.apify.com/v2/acts/${process.env.APIFY_TIKTOK_ACTOR}/run-sync-get-dataset-items?token=${process.env.APIFY_TOKEN}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: process.env.APIFY_INPUT || '{}', signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const rows = await r.json();
  return rows.slice(0, 60).map((v, i) => ({
    id: 'tt_' + (v.id || i), source: 'tiktok', kind: 'meme', title: clean(v.text || v.desc || v.title || ''),
    url: v.webVideoUrl || v.url || 'https://tiktok.com', image: v.covers ? v.covers[0] : '', author: (v.authorMeta && v.authorMeta.name) || 'TikTok',
    ts: v.createTimeISO ? Date.parse(v.createTimeISO) : now(),
    score: (v.diggCount || v.likes || 0) / 10, comments: v.commentCount || 0,
  }));
}
 
 
/* ---------- RSS / Atom news feeds (no keys). Each feed shows as its own chip, so dead ones are visible. ---------- */
const FEEDS = [
  ['BBC', 'https://feeds.bbci.co.uk/news/world/rss.xml', 'news'],
  ['BBC Tech', 'https://feeds.bbci.co.uk/news/technology/rss.xml', 'news'],
  ['Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml', 'news'],
  ['Guardian', 'https://www.theguardian.com/world/rss', 'news'],
  ['NYT', 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', 'news'],
  ['CNN', 'http://rss.cnn.com/rss/edition.rss', 'news'],
  ['NPR', 'https://feeds.npr.org/1001/rss.xml', 'news'],
  ['Google News', 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en', 'news'],
  ['TechCrunch', 'https://techcrunch.com/feed/', 'news'],
  ['The Verge', 'https://www.theverge.com/rss/index.xml', 'news'],
  ['Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index', 'news'],
  ['Wired', 'https://www.wired.com/feed/rss', 'news'],
  ['Engadget', 'https://www.engadget.com/rss.xml', 'news'],
  ['Variety', 'https://variety.com/feed/', 'news'],
  ['ESPN', 'https://www.espn.com/espn/rss/news', 'news'],
  ['Know Your Meme', 'https://knowyourmeme.com/newsfeed.rss', 'meme'],
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/', 'news'],
  ['Cointelegraph', 'https://cointelegraph.com/rss', 'news'],
  ['Decrypt', 'https://decrypt.co/feed', 'news'],
];
const tag = (b, name) => { const m = b.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i')); return m ? m[1] : ''; };
const unCdata = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const plain = (s) => clean(unCdata(s).replace(/<[^>]+>/g, ' ').replace(/&lt;[^&]*&gt;/g, ' ').replace(/&nbsp;/g, ' '));
 
function parseFeed(xml, name, kind) {
  const out = [];
  const blocks = [...xml.matchAll(/<(item|entry)[\s>]([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  blocks.slice(0, 40).forEach((b, pos) => {
    const title = plain(tag(b, 'title'));
    let link = plain(tag(b, 'link')) || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    if (!link) link = plain(tag(b, 'guid'));
    const date = plain(tag(b, 'pubDate')) || plain(tag(b, 'published')) || plain(tag(b, 'updated')) || plain(tag(b, 'dc:date'));
    let ts = Date.parse(date);
    if (!ts || ts > now() + 3600000) ts = now();
    const img = (b.match(/<media:(?:content|thumbnail)[^>]*url="([^"]+)"/i) || b.match(/<enclosure[^>]*url="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i) || b.match(/<img[^>]*src="([^"]+)"/i) || [])[1] || '';
    if (!title || !link) return;
    // RSS has no votes. Items higher in a feed are the outlet's own top stories, so use position as a weak score.
    out.push({ id: 'rss_' + link, source: name, kind, title, url: link, image: img, author: name, ts, score: Math.max(5, 120 - pos * 4), comments: 0 });
  });
  return out;
}
 
// Wikipedia's most-read articles of the last full day: a good "what are people searching" signal. No key.
async function srcWiki() {
  let j, lastErr;
  for (let back = 1; back <= 3 && !j; back++) {
    const d = new Date(now() - back * 86400000);
    const u = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    try { j = await getJSON(u); } catch (e) { lastErr = e; }
  }
  if (!j) throw lastErr || new Error('no data');
  const out = [];
  for (const a of j.items[0].articles) {
    if (/^(Main_Page|Special:|Wikipedia:|Portal:|Help:|File:|Category:|Talk:|-$)/.test(a.article)) continue;
    const id = 'wp_' + a.article;
    const old = items.get(id);
    out.push({ id, source: 'wikipedia', kind: 'trend', title: a.article.replace(/_/g, ' '), url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(a.article),
      image: '', author: fmtN(a.views) + ' просмотров вчера', ts: old ? old.ts : now(), score: a.views / 1000, comments: 0 });
    if (out.length >= 40) break;
  }
  return out;
}
 
const SOURCES = [
  { name: 'reddit', every: 90, run: srcReddit },
  { name: 'hackernews', every: 45, run: srcHN },
  { name: 'trends', every: 180, run: srcTrends },
  { name: 'mastodon', every: 60, run: srcMastodon },
  { name: 'bluesky', every: 30, run: srcBluesky },
  { name: 'wikipedia', every: 3600, run: srcWiki },
  ...FEEDS.map(([name, url, kind]) => ({ name, every: 60, run: async () => parseFeed(await getText(url, { Accept: 'application/rss+xml, application/xml, text/xml, */*' }), name, kind) })),
  { name: 'x', every: 120, run: srcX },
  { name: 'tiktok', every: 600, run: srcTikTok },
];
 
/* ----------------------------- scoring ----------------------------- */
const MEME_WORDS = ['cat', 'kitten', 'dog', 'puppy', 'frog', 'capybara', 'hamster', 'duck', 'penguin', 'monkey', 'pig', 'goat', 'bear', 'raccoon', 'otter', 'squirrel', 'pepe', 'doge', 'moo', 'bird', 'fish', 'cow', 'baby', 'guy', 'girl', 'man',
  'rizz', 'skibidi', 'sigma', 'brainrot', 'cooked', 'goated', 'based', 'mid', 'delulu', 'aura', 'npc', 'ratio', 'cringe', 'vibe', 'chill', 'unc', 'huzz', 'gyatt', 'viral', 'meme', 'trend', 'challenge', 'routine', 'wtf', 'lmao', 'lol'];
const NEWS_HOOKS = ['trump', 'musk', 'elon', 'biden', 'putin', 'zelensky', 'openai', 'chatgpt', 'grok', 'altman', 'nvidia', 'apple', 'tesla', 'bitcoin', 'solana', 'ai', 'robot', 'election', 'tiktok', 'spacex', 'mars', 'nasa', 'ufo', 'alien', 'taylor', 'kanye', 'drake', 'kendrick', 'messi', 'ronaldo', 'ban', 'leak', 'arrested', 'fired', 'record'];
const SENSITIVE = /\b(dies|died|dead|death|killed|shooting|shot dead|suicide|murder|rape|abuse|funeral|rip|victims?|massacre|terror|attack|crash|tragedy|missing child)\b/i;
const SPAM = /\b(giveaway|promo code|discount|sponsored|affiliate|subscribe|follow me|dm me|whatsapp|telegram|airdrop|presale|guaranteed)\b/i;
const STOP = new Set('this that with from have your what when will just they them been were about into over more than then like make made some very much also after before there their which would could should today here only does most other'.split(' '));
 
const tokens = (s) => (String(s).toLowerCase().match(/[a-z0-9$]{3,}/g) || []).filter((w) => !STOP.has(w));
 
function percentileMap(list, f) {
  const sorted = [...list].map(f).sort((a, b) => a - b);
  return (v) => {
    if (sorted.length < 2) return 0.5;
    let lo = 0; while (lo < sorted.length && sorted[lo] < v) lo++;
    return lo / (sorted.length - 1);
  };
}
 
function suggestTicker(it) {
  const toks = tokens(it.title);
  const meme = toks.find((t) => MEME_WORDS.includes(t));
  const caps = (it.title.match(/\b[A-Z][a-z]{3,}\b/g) || []).map((s) => s.toLowerCase()).find((s) => !STOP.has(s));
  const longest = [...toks].sort((a, b) => b.length - a.length)[0];
  const pick = caps || meme || longest || 'meme';
  return pick.replace(/[^a-z0-9]/g, '').slice(0, 8).toUpperCase();
}
 
function rescore() {
  const live = [...items.values()].filter((i) => ageH(i.ts) <= MAX_AGE_H || i.kind === 'coin');
  const bySource = {};
  for (const i of live) (bySource[i.source] ||= []).push(i);
 
  for (const list of Object.values(bySource)) {
    const vel = (i) => (i.score + 3 * i.comments) / Math.pow(ageH(i.ts) + 2, 1.2);
    const pct = percentileMap(list, vel);
    for (const i of list) i._vel = pct(vel(i));
  }
 
  // Same story on several different sources = it is spreading. Inverted index keeps this fast with thousands of items.
  const toks = live.map((i) => [...new Set(tokens(i.title))]);
  const post = new Map();
  toks.forEach((ts, idx) => ts.forEach((w) => { if (!post.has(w)) post.set(w, []); post.get(w).push(idx); }));
  live.forEach((a, ai) => {
    const counts = new Map();
    for (const w of toks[ai]) {
      const list = post.get(w);
      if (list.length > 60) continue; // too common to mean anything
      for (const bi of list) if (bi !== ai && live[bi].source !== a.source) counts.set(bi, (counts.get(bi) || 0) + 1);
    }
    const need = toks[ai].length <= 4 ? 2 : 3;
    const sources = new Set();
    for (const [bi, c] of counts) if (c >= need) sources.add(live[bi].source);
    a.cross = sources.size;
  });
 
  for (const it of live) {
    const toks = tokens(it.title);
    const reasons = [];
    let s = it._vel * 55;
    if (it._vel > 0.85) reasons.push('momentum');
    const memeHits = toks.filter((t) => MEME_WORDS.includes(t)).length;
    if (memeHits) { s += Math.min(14, 7 * memeHits); reasons.push('meme-able'); }
    const newsHits = toks.filter((t) => NEWS_HOOKS.includes(t)).length;
    if (newsHits) { s += Math.min(12, 6 * newsHits); reasons.push('news hook'); }
    if (it.cross) { s += Math.min(20, 12 * it.cross); reasons.push('seen on ' + (it.cross + 1) + ' platforms'); }
    const h = ageH(it.ts);
    if (h < 3) { s += 8; reasons.push('fresh'); } else if (h > 18) s -= 8;
    if (it.image) s += 3;
    if (it.title.length < 8) s -= 25;
    if (it.title.length > 140) s -= 6;
    if (it.kind === 'coin') { s = 40 + it._vel * 45; reasons.length = 0; if (it._vel > 0.7) reasons.push('trading hot'); }
 
    it.flags = [];
    if (SPAM.test(it.title)) { s -= 60; it.flags.push('spam'); }
    if (SENSITIVE.test(it.title)) { s -= 60; it.flags.push('sensitive'); }
    if (it.title === it.title.toUpperCase() && it.title.length > 20) s -= 10;
 
    it.rank = Math.max(0, Math.min(100, Math.round(s)));
    it.tier = it.flags.length ? 'skip' : it.rank >= 68 ? 'hot' : it.rank >= 48 ? 'watch' : it.rank >= 30 ? 'meh' : 'junk';
    it.reasons = reasons;
    if (it.kind !== 'coin') it.ticker = suggestTicker(it);
    // Already has a coin on Solana -> mark it, but keep it visible.
    if (it.kind !== 'coin' && it.coin && (it.coin.verdict === 'taken' || it.coin.verdict === 'crowded')) it.tier = 'taken';
 
    // "Rising" tab: a post that is visibly picking up speed. Once it qualifies it stays there.
    const g = growth(it);
    it.growth = g ? Math.round(g.perHour) : 0;
    if (it.kind !== 'coin' && !it.flags.length && ageH(it.ts) <= 24 && !it.risingAt) {
      let why = '';
      if (g && g.delta >= 40 && g.delta >= 0.25 * g.base) why = 'резкий рост: +' + fmtN(g.delta) + ' за час';
      else if (it._vel >= 0.9 && it.rank >= 55) why = 'в топе своей площадки';
      else if (it.cross >= 1 && it.rank >= 50) why = 'на ' + (it.cross + 1) + ' площадках сразу';
      if (why) { it.risingAt = now(); it.risingWhy = why; }
    }
  }
}
const fmtN = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(Math.round(n)));
 
/* --------------------- "is it already a coin?" --------------------- */
async function coinCheck(ticker) {
  const c = coinCache.get(ticker);
  if (c && now() - c.t < 30 * 60000) return c.data;
  let data = null;
  try {
    const j = await getJSON('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(ticker));
    const sol = (j.pairs || []).filter((p) => p.chainId === 'solana');
    const exact = sol.filter((p) => (p.baseToken.symbol || '').toUpperCase() === ticker);
    const best = exact.sort((a, b) => (b.fdv || 0) - (a.fdv || 0))[0];
    data = {
      copies: exact.length,
      topMcap: best ? best.fdv || 0 : 0,
      url: best ? best.url : '',
      verdict: !exact.length ? 'open' : (best.fdv || 0) > 300000 ? 'taken' : exact.length > 5 ? 'crowded' : 'early',
    };
  } catch (_) { data = null; }
  coinCache.set(ticker, { t: now(), data });
  return data;
}
 
async function enrichTop() {
  // Check the best candidates (hot, watch, and already-flagged ones so they can come back if the coin dies).
  const cand = [...items.values()].filter((i) => i.kind !== 'coin' && i.ticker && !i.flags.length && (i.risingAt || i.rank >= 55)).sort((a, b) => (b.risingAt || 0) - (a.risingAt || 0) || b.rank - a.rank).slice(0, 30);
  for (const it of cand) {
    const d = await coinCheck(it.ticker);
    if (d) it.coin = d;
  }
  rescore();
}
 
/* ----------------------------- loop & SSE ----------------------------- */
function view() {
  return [...items.values()]
    .filter((i) => ageH(i.ts) <= MAX_AGE_H || i.kind === 'coin')
    .sort((a, b) => (b.risingAt ? 1 : 0) - (a.risingAt ? 1 : 0) || b.ts - a.ts)
    .slice(0, 800)
    .map(({ id, source, kind, title, url, image, author, ts, score, comments, rank, tier, reasons, flags, ticker, coin, firstSeen, extra, risingAt, risingWhy, growth }) =>
      ({ id, source, kind, title, url, image, author, ts, score, comments, rank, tier, reasons, flags, ticker, coin, firstSeen, extra, risingAt, risingWhy, growth }));
}
let version = 1;
function broadcast() {
  version++;
  if (!clients.size) return;
  const msg = `event: snapshot\ndata: ${JSON.stringify({ version, items: view(), status })}\n\n`;
  for (const c of clients) c.write(msg);
}
 
function prune() {
  for (const [id, i] of items) if (ageH(i.ts) > MAX_AGE_H * 2 && i.kind !== 'coin') items.delete(id);
  for (const [id, i] of items) if (i.kind === 'coin' && ageH(i.firstSeen) > 6) items.delete(id);
  if (items.size > 4000) {
    const old = [...items.entries()].filter(([, i]) => !i.risingAt).sort((a, b) => a[1].ts - b[1].ts).slice(0, items.size - 3500);
    for (const [id] of old) items.delete(id);
  }
}
 
// Many sources finish within seconds of each other. Rescore once for the whole batch, not once per source.
let pending = false, working = false;
function schedule() {
  if (pending) return;
  pending = true;
  setTimeout(async () => {
    pending = false;
    if (working) return schedule();
    working = true;
    try { prune(); rescore(); broadcast(); await enrichTop(); broadcast(); } catch (e) { console.error('update failed', e); }
    working = false;
  }, 1500);
}
 
async function runSource(src) {
  try {
    const rows = await src.run();
    if (rows === null) { status[src.name] = { ok: false, off: true, error: 'not configured' }; return schedule(); }
    for (const r of rows) upsert(r);
    status[src.name] = { ok: true, last: now(), count: rows.length };
  } catch (e) {
    status[src.name] = { ok: false, last: now(), error: String(e.message || e) };
  }
  schedule();
}
 
function start() {
  SOURCES.forEach((s, i) => {
    // Stagger the first requests so we don't hit every site in the same second.
    setTimeout(() => { runSource(s); setInterval(() => runSource(s), s.every * 1000).unref?.(); }, i * 400);
  });
}
 
/* ----------------------------- http ----------------------------- */
const server = http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: snapshot\ndata: ${JSON.stringify({ version, items: view(), status })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (req.url.split('?')[0] === '/api/items') {
    const v = Number((new URL(req.url, 'http://x').searchParams.get('v')) || 0);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    if (v === version) return res.end(JSON.stringify({ version, unchanged: true }));
    return res.end(JSON.stringify({ version, items: view(), status }));
  }
  // Serve index.html from ./public or, if it was uploaded next to server.js, from the project root.
  const name = req.url.split('?')[0] === '/' ? 'index.html' : path.basename(req.url.split('?')[0]);
  const tryFiles = [path.join(__dirname, 'public', name), path.join(__dirname, name)];
  const send = (i) => {
    if (i >= tryFiles.length || !name.endsWith('.html')) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(tryFiles[i], (err, buf) => {
      if (err) return send(i + 1);
      res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
      res.end(buf);
    });
  };
  send(0);
});
 
/* ----------------------------- self test ----------------------------- */
if (process.argv.includes('--selftest')) {
  const t = now();
  const mk = (id, source, title, score, comments, hrs) => upsert({ id, source, kind: 'meme', title, url: '#', image: '', author: 'x', ts: t - hrs * 3600000, score, comments });
  mk('a', 'reddit', 'Capybara in a tiny hat refuses to leave the hot tub', 24000, 900, 2);
  mk('b', 'reddit', 'Mildly interesting rock', 12, 1, 5);
  mk('c', 'reddit', 'FREE GIVEAWAY follow me on telegram airdrop', 3000, 5, 1);
  mk('d', 'reddit', 'Man dies in tragic crash, family mourns', 9000, 800, 1);
  mk('e', 'hackernews', 'Musk says Grok will ship a robot capybara', 800, 400, 2);
  mk('f', 'trends', 'Capybara hot tub: viral video trends', 2000, 0, 1);
  mk('g', 'reddit', 'Chill guy meme gets a sequel', 500, 80, 1);
  rescore();
  for (const i of [...items.values()].sort((a, b) => b.rank - a.rank)) console.log(String(i.rank).padStart(3), i.tier.padEnd(6), i.ticker || '', '|', i.title, '|', i.reasons.join(', '), i.flags.join(','));
  process.exit(0);
}
 
server.listen(PORT, () => { console.log('MemePulse on http://localhost:' + PORT); start(); });
 
