import { getMedia } from "../core/anilist.js";
import {
  UA,
  buildTitles,
  decodeEntities,
  episodeMeta,
  expectedCount,
  findTopSlugs,
  getPrequelOffset,
  json,
  selectSeries,
  stripTags,
} from "../core/new-provider-utils.js";
import { get, set, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";

// AnimeHeaven is not behind Cloudflare, so plain fetch is enough here (no wreq
// fingerprinting needed). It only publishes sub streams as direct MP4 files.
const BASE = "https://animeheaven.me";
const REQUEST_TIMEOUT_MS = 20_000;
const SEARCH_CACHE_TTL = 2 * 60_000;

// ---------------------------------------------------------------------------
// HTTP + cookies
// ---------------------------------------------------------------------------

// gate.php can be session-bound and fetch() does not persist Set-Cookie on its
// own, so keep the site's first-party cookies and send them back on gate
// requests. The per-episode `key` cookie is added per request and is never
// stored in the jar, so concurrent watch requests cannot clobber each other.
const cookieJar = new Map();

function captureCookies(response) {
  const setCookie = typeof response.headers?.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const raw of setCookie) {
    const parts = String(raw).split(";").map((part) => part.trim());
    const pair = parts[0] ?? "";
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1);
    const maxAge = parts.slice(1).find((part) => /^max-age=/i.test(part))?.split("=")[1];
    if (!value || (maxAge !== undefined && Number(maxAge) <= 0)) cookieJar.delete(name);
    else cookieJar.set(name, value);
  }
}

function cookieHeader(key) {
  const jar = new Map(cookieJar);
  if (key) jar.set("key", key);
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function heavenFetch(path, { params, headers = {}, key } = {}) {
  const url = new URL(path, BASE);
  for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, String(value));
  const cookie = cookieHeader(key);
  const response = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${BASE}/`,
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  captureCookies(response);
  const body = await response.text();
  if (!response.ok) {
    const error = new Error(`AnimeHeaven HTTP ${response.status}: ${url.pathname}`);
    error.status = response.status;
    error.rawBody = body.slice(0, 1200);
    throw error;
  }
  return body;
}

// ---------------------------------------------------------------------------
// HTML parsing (exported for tests)
// ---------------------------------------------------------------------------

// Matches an opening tag's attribute text even when a quoted value contains ">".
const ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*)`;

function attribute(attributes, name) {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? decodeEntities(match[1] ?? match[2] ?? "") : "";
}

function slugify(value) {
  return String(value).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function parseSearchResults(html) {
  const results = [];
  for (const match of html.matchAll(new RegExp(`<a\\b${ATTRS}>([\\s\\S]*?)</a>`, "gi"))) {
    const href = attribute(match[1], "href");
    if (!/anime\.php\?/i.test(href)) continue;
    const id = href.split("?")[1]?.trim();
    const inner = match[2];
    const fastName = inner.match(/<([a-z][a-z0-9]*)\b[^>]*class=["'][^"']*\bfastname\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i)?.[2];
    const imgTag = inner.match(new RegExp(`<img\\b${ATTRS}>`, "i"))?.[1] ?? "";
    const title = (fastName ? stripTags(fastName) : "") || attribute(imgTag, "alt").trim();
    if (!id || !title) continue;
    const src = attribute(imgTag, "src");
    let image;
    try { image = src ? new URL(src, BASE).href : undefined; } catch { image = undefined; }
    results.push({ id, title, image });
  }
  return results;
}

function decodeKey(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function parseEpisodes(html) {
  const episodes = [];
  for (const match of html.matchAll(new RegExp(`<a\\b${ATTRS}>([\\s\\S]*?)</a>`, "gi"))) {
    const attributes = match[1];
    const inner = match[2];
    const text = stripTags(inner);
    const attrs = [attribute(attributes, "onmouseover"), attribute(attributes, "onclick"), attribute(attributes, "href")].join(" ");

    // The site has changed its episode-link markup/quoting over time, so look
    // at episode-looking anchors broadly and accept both quote styles.
    if (!/(?:gate[ha]\s*\(|gate\.php|episode)/i.test(`${attrs} ${text}`)) continue;

    const key = attrs.match(/gate[ha]\s*\(\s*["']([^"']+)["']/i)?.[1]
      || attrs.match(/gate[ha]\s*\(\s*([^,)\s]+)/i)?.[1]
      || attribute(attributes, "href").match(/[?&](?:key|id)=([^&#]+)/i)?.[1];

    const watch2 = inner.match(/<[^>]*class=["'][^"']*\bwatch2\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1];
    const rawNum = (watch2 ? stripTags(watch2) : "")
      || text.match(/episode\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1]
      || text.match(/^([0-9]+(?:\.[0-9]+)?)$/)?.[1]
      || "";
    if (!key || !rawNum) continue;

    const number = Number(rawNum.replace(/^0+(\d)/, "$1"));
    // Fractional entries (recaps such as "12.5") cannot be mapped onto AniList
    // numbering, so only whole episodes are exposed.
    if (!Number.isInteger(number)) continue;

    episodes.push({ number, title: `Episode ${number}`, key: decodeKey(key), hasSub: true, hasDub: false });
  }
  const byKey = new Map(episodes.map((episode) => [episode.key, episode]));
  const seen = new Set();
  return [...byKey.values()]
    .sort((a, b) => a.number - b.number)
    .filter((episode) => seen.has(episode.number) ? false : (seen.add(episode.number), true));
}

// gate.php sometimes returns AnimeHeaven's short placeholder player instead of
// the requested episode. That must never be exposed as if it were a stream.
export function parseGateSources(html) {
  if (/watch\s+episode\s+on\s+animeheaven\.me/i.test(stripTags(html))) return null;
  const sources = [];
  for (const video of html.matchAll(/<video\b[\s\S]*?<\/video>/gi)) {
    for (const source of video[0].matchAll(new RegExp(`<source\\b${ATTRS}>`, "gi"))) {
      let src = attribute(source[1], "src").trim();
      if (src.startsWith("//")) src = `https:${src}`;
      if (/^https?:\/\//i.test(src)) sources.push(src);
    }
  }
  const unique = [...new Set(sources)];
  // Prefer an explicit MP4 source, then keep the rest in page order.
  return unique.sort((a, b) => Number(/\.mp4(?:$|\?)/i.test(b)) - Number(/\.mp4(?:$|\?)/i.test(a)));
}

// ---------------------------------------------------------------------------
// Upstream calls
// ---------------------------------------------------------------------------

const searchCache = new Map();

function cachedSearch(query) {
  const key = String(query).trim().replace(/\s+/g, " ").toLowerCase();
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise.then((results) => results.map((result) => ({ ...result })));
  // The promise is cached immediately so concurrent identical searches coalesce.
  const promise = heavenFetch("/fastsearch.php", { params: { xhr: 1, s: query }, headers: { Accept: "text/html,*/*" } })
    .then(parseSearchResults);
  promise.catch(() => { if (searchCache.get(key)?.promise === promise) searchCache.delete(key); });
  searchCache.set(key, { promise, expiresAt: Date.now() + SEARCH_CACHE_TTL });
  while (searchCache.size > 160) searchCache.delete(searchCache.keys().next().value);
  return promise.then((results) => results.map((result) => ({ ...result })));
}

async function search(query) {
  let results = await cachedSearch(query);
  if (!results.length) {
    // The fast search can tokenize spaced titles unexpectedly: "DAN DA DAN"
    // finds nothing while "DANDADAN" does. Retry with compact/apostrophe-free forms.
    const compact = query.toLowerCase().replace(/[^a-z0-9]/g, "");
    const noApostrophes = query.replace(/[’']s\b/gi, "").replace(/[’']/g, "");
    const variants = [noApostrophes, compact].filter((variant, index, all) =>
      variant.length >= 3 && variant.toLowerCase() !== query.toLowerCase() && all.indexOf(variant) === index);
    for (const variant of variants) {
      results = await cachedSearch(variant).catch(() => []);
      if (results.length) break;
    }
  }
  // The anime id is an opaque token, so expose a title-derived slug to the
  // shared matcher (digits in a random id would skew its season heuristics)
  // and carry the real id alongside it.
  const bySlug = new Map();
  for (const result of results) {
    const slug = slugify(result.title) || result.id;
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, text: result.title, id: result.id, image: result.image });
  }
  return [...bySlug.values()];
}

async function scrapeSeries(animeId) {
  // The id is the bare query string (`anime.php?<id>`), so it is appended raw
  // rather than passed through URLSearchParams, which would add a trailing "=".
  return parseEpisodes(await heavenFetch(`/anime.php?${animeId}`));
}

async function fetchGateSources(key, referer = `${BASE}/`) {
  const html = await heavenFetch("/gate.php", {
    key,
    headers: {
      Referer: referer,
      Origin: BASE,
      "Cache-Control": "no-cache",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
    },
  });
  return parseGateSources(html);
}

// ---------------------------------------------------------------------------
// Matching + API surface
// ---------------------------------------------------------------------------

// AnimeHeaven lists dubs as separate entries; this provider is sub-only, so a
// dub entry must never be matched as the main series.
function isDubEntry(candidate) {
  return /(?:^|[-\s(])dub(?:bed)?(?:$|[-\s)])/i.test(`${candidate.slug} ${candidate.title ?? ""}`);
}

async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:match1:animeheaven:${anilistId}`;
  const cached = get(cacheKey);
  if (isFresh(cached)) return cached.data;

  const media = ctx.media ?? await getMedia(anilistId);
  const titles = buildTitles(media, ctx.anizip);
  const candidates = (await findTopSlugs(titles, search)).filter((candidate) => !isDubEntry(candidate));
  const idBySlug = new Map(candidates.map((candidate) => [candidate.slug, candidate.id]));
  const expected = expectedCount(media, ctx.anizip);
  const offset = await getPrequelOffset(anilistId).catch(() => 0);
  const selected = await selectSeries(candidates, (slug) => scrapeSeries(idBySlug.get(slug)), expected, media?.status, offset);
  if (!selected) throw new Error(`AnimeHeaven match not found for AniList ${anilistId}`);
  const data = { id: selected.id, slug: selected.slug, title: selected.title, mode: selected.mode, offset, score: selected.score };
  set(cacheKey, data, SHOW_IDENTITY_TTL);
  return data;
}

function buildEpisodeLists(anilistId, series, providerEpisodes, ctx, expected) {
  const sub = [];
  for (const src of providerEpisodes) {
    const number = series.mode === "offset" ? src.number - series.offset : src.number;
    if (number < 1) continue;
    if (expected && number > expected) continue;
    const meta = episodeMeta(number, ctx);
    sub.push({
      number,
      title: meta.title ?? src.title ?? `Episode ${number}`,
      duration: meta.duration,
      filler: meta.filler,
      uncensored: meta.uncensored,
      description: meta.description,
      image: meta.image,
      airDate: meta.airDate,
      sourceNumber: src.number,
      id: `watch/animeheaven/${anilistId}/sub/animeheaven-${number}`,
      audio: "sub",
    });
  }
  return { sub, dub: [] };
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  const localCtx = { ...ctx, media };
  const series = await resolveSeries(anilistId, localCtx);
  const episodes = await scrapeSeries(series.id);
  const expected = expectedCount(media, ctx.anizip);
  return {
    meta: {
      id: series.id,
      title: series.title,
      source: "animeheaven",
      matchScore: Number(series.score.toFixed(3)),
      numbering: series.mode,
      episodeOffset: series.mode === "offset" ? series.offset : 0,
    },
    episodes: buildEpisodeLists(anilistId, series, episodes, localCtx, expected),
  };
}

async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  if (audio !== "sub") return json({ error: "AnimeHeaven only provides sub streams" }, 404);
  const series = await resolveSeries(anilistId, ctx);
  const providerEp = series.mode === "offset" ? Number(epNum) + series.offset : Number(epNum);
  // Always re-read the anime page right before the gate request: the episode
  // keys and the session cookies they belong to are then as fresh as possible.
  const episodes = await scrapeSeries(series.id);
  const ep = episodes.find((episode) => episode.number === providerEp);
  if (!ep) return json({ error: `AnimeHeaven episode ${providerEp} not found` }, 404);

  const sources = await fetchGateSources(ep.key, `${BASE}/anime.php?${series.id}`);
  if (!sources?.length) return json({ error: `AnimeHeaven returned no playable source for episode ${providerEp}` }, 404);

  return json({
    anilistId: Number(anilistId),
    episode: Number(epNum),
    providerEpisode: providerEp,
    audio,
    streams: sources.map((url, index) => ({
      url,
      type: "mp4",
      server: "AnimeHeaven",
      audio,
      referer: `${BASE}/`,
      priority: sources.length - index,
      isActive: index === 0,
    })),
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" } });
    }
    try {
      const m = url.pathname.match(/^\/watch\/animeheaven\/(\d+)\/(sub|dub)\/animeheaven-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, "Raw-ERROR": err.rawBody ?? null, stack: err.stack }, 500);
    }
  },
};
