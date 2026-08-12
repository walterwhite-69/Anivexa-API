import { getMedia } from "../core/anilist.js";
import {
  attr,
  buildTitles,
  decodeEntities,
  episodeMeta,
  expectedCount,
  json,
  stripTags,
} from "../core/new-provider-utils.js";
import { get, set, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const BASE = "https://anidb.app";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const COOKIE_JAR = "/tmp/anidbapp_cookies.txt";

const NAV_HEADERS = [
  "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language: en-US,en;q=0.9",
  "sec-ch-ua: \"Google Chrome\";v=\"137\", \"Chromium\";v=\"137\", \"Not/A)Brand\";v=\"24\"",
  "sec-ch-ua-mobile: ?0",
  "sec-ch-ua-platform: \"Windows\"",
  "sec-fetch-dest: document",
  "sec-fetch-mode: navigate",
  "sec-fetch-site: none",
  "sec-fetch-user: ?1",
  "upgrade-insecure-requests: 1",
];

const XHR_HEADERS = [
  "Accept: application/json, text/html, */*;q=0.8",
  "Accept-Language: en-US,en;q=0.9",
  "sec-ch-ua: \"Google Chrome\";v=\"137\", \"Chromium\";v=\"137\", \"Not/A)Brand\";v=\"24\"",
  "sec-ch-ua-mobile: ?0",
  "sec-ch-ua-platform: \"Windows\"",
  "sec-fetch-dest: empty",
  "sec-fetch-mode: cors",
  "sec-fetch-site: same-origin",
  "X-Requested-With: XMLHttpRequest",
];

async function curlFetch(url, headers, extraArgs = []) {
  const args = [
    "-s",
    "--compressed",
    "-A", UA,
    "-c", COOKIE_JAR,
    "-b", COOKIE_JAR,
    "-w", "\n__STATUS:%{http_code}",
    ...headers.flatMap(h => ["-H", h]),
    ...extraArgs,
    url,
  ];
  const { stdout } = await execFileAsync("curl", args, { maxBuffer: 8 * 1024 * 1024 });
  const sep = stdout.lastIndexOf("\n__STATUS:");
  const status = sep >= 0 ? Number(stdout.slice(sep + 10)) : 0;
  const body = sep >= 0 ? stdout.slice(0, sep) : stdout;
  if (status < 200 || status >= 300) {
    const err = new Error(`HTTP ${status} fetching ${url}`);
    err.rawBody = body;
    throw err;
  }
  return body;
}

async function fetchAnidbHtml(url, referer) {
  const headers = referer ? [...NAV_HEADERS, `Referer: ${referer}`] : NAV_HEADERS;
  return curlFetch(url, headers);
}

async function fetchXhr(url, referer) {
  const headers = referer ? [...XHR_HEADERS, `Referer: ${referer}`] : XHR_HEADERS;
  return curlFetch(url, headers);
}

async function fetchJson(url, referer) {
  const text = await fetchXhr(url, referer);
  return JSON.parse(text);
}

async function search(query) {
  const html = await fetchXhr(`${BASE}/search/suggestions?q=${encodeURIComponent(query)}`, `${BASE}/home`).catch(() => "");
  const results = [];
  for (const m of html.matchAll(/<a\b[^>]*data-search-item\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = m[0].match(/<a\b[^>]*>/i)?.[0] ?? "";
    const href = attr(tag, "href");
    const path = href.startsWith("http") ? new URL(href).pathname : href;
    const slug = path.match(/^\/anime\/([^/?#]+)/)?.[1];
    if (!slug) continue;
    const title = stripTags(m[0].match(/<p\b[^>]*class=["'][^"']*text-sm[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
    const meta = stripTags(m[0].match(/<p\b[^>]*class=["'][^"']*text-xs[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
    const siteId = Number(slug.match(/-(\d+)$/)?.[1]);
    results.push({ slug, title: title || slug.replace(/-/g, " "), meta, siteId });
  }
  if (results.length) return results;

  const browseHtml = await fetchAnidbHtml(`${BASE}/browse?q=${encodeURIComponent(query)}`, `${BASE}/home`).catch(() => "");
  const seen = new Set();
  for (const m of browseHtml.matchAll(/<a\b[^>]*href=["'](?:https:\/\/anidb\.app)?\/anime\/([^"']+)["'][^>]*class=["'][^"']*\banime-card\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const title = stripTags(m[0].match(/title=["']([^"']+)["']/i)?.[1] ?? "")
      || stripTags(m[0].match(/alt=["']([^"']+)["']/i)?.[1] ?? "")
      || slug.replace(/-/g, " ");
    const siteId = Number(slug.match(/-(\d+)$/)?.[1]);
    results.push({ slug, title, meta: "", siteId });
  }
  return results;
}

function parseExternalIds(html) {
  return {
    anilistId: Number(html.match(/https:\/\/anilist\.co\/anime\/(\d+)/i)?.[1]) || null,
    malId: Number(html.match(/https:\/\/myanimelist\.net\/anime\/(\d+)/i)?.[1]) || null,
    anidbId: Number(html.match(/https:\/\/anidb\.net\/anime\/(\d+)/i)?.[1]) || null,
    kitsuId: Number(html.match(/https:\/\/kitsu\.app\/anime\/(\d+)/i)?.[1]) || null,
  };
}

function parsePageTitle(html) {
  return stripTags(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
}

function searchQueries(media, anizip) {
  const titles = buildTitles(media, anizip);
  const out = new Set();
  for (const title of titles.slice(0, 5)) {
    out.add(title);
    const words = title.trim().split(/\s+/);
    if (words.length > 4) out.add(words.slice(0, 4).join(" "));
  }
  return [...out].filter((q) => q.length >= 2);
}

async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:anidbapp:${anilistId}`;
  const cached = get(cacheKey);
  if (isFresh(cached)) return cached.data;

  const media = ctx.media ?? await getMedia(anilistId);
  const queries = searchQueries(media, ctx.anizip);
  const candidates = new Map();
  await Promise.all(queries.map(async (q) => {
    for (const r of await search(q).catch(() => [])) {
      if (!candidates.has(r.slug)) candidates.set(r.slug, r);
    }
  }));

  for (const candidate of candidates.values()) {
    const html = await fetchAnidbHtml(`${BASE}/anime/${candidate.slug}`, `${BASE}/home`).catch(() => "");
    if (!html) continue;
    const ids = parseExternalIds(html);
    if (ids.anilistId !== Number(anilistId)) continue;
    const data = {
      slug: candidate.slug,
      siteId: candidate.siteId || Number(candidate.slug.match(/-(\d+)$/)?.[1]),
      title: parsePageTitle(html) || candidate.title,
      matchType: "anilist",
      matchScore: 1,
      ...ids,
    };
    set(cacheKey, data, SHOW_IDENTITY_TTL);
    return data;
  }

  const malId = media?.idMal ?? null;
  if (malId) {
    for (const candidate of candidates.values()) {
      const html = await fetchAnidbHtml(`${BASE}/anime/${candidate.slug}`, `${BASE}/home`).catch(() => "");
      if (!html) continue;
      const ids = parseExternalIds(html);
      if (ids.anilistId || ids.malId !== Number(malId)) continue;
      const data = {
        slug: candidate.slug,
        siteId: candidate.siteId || Number(candidate.slug.match(/-(\d+)$/)?.[1]),
        title: parsePageTitle(html) || candidate.title,
        matchType: "mal",
        matchScore: 0.9,
        ...ids,
      };
      set(cacheKey, data, SHOW_IDENTITY_TTL);
      return data;
    }
  }

  throw new Error(`AniDB.app match not found for AniList ${anilistId}`);
}

async function fetchProviderEpisodes(siteId) {
  const data = await fetchJson(`${BASE}/api/frontend/anime/${siteId}/episodes`, `${BASE}/anime/${siteId}`);
  return Array.isArray(data.episodes) ? data.episodes : [];
}

function inferOffset(providerEpisodes, expected) {
  const nums = providerEpisodes.map((e) => Number(e.number)).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length || !expected) return 0;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (min > expected) return min - 1;
  if (min > 1 && max - min + 1 >= expected) return min - 1;
  return 0;
}

async function fetchLanguages(episodeId, seriesSlug) {
  const data = await fetchJson(`${BASE}/api/frontend/episode/${episodeId}/languages`, `${BASE}/anime/${seriesSlug}`).catch(() => null);
  return Array.isArray(data?.languages) ? data.languages : [];
}

function hasLanguage(languages, audio) {
  return Boolean(languageForAudio(languages, audio)?.embed_url);
}

function buildEpisodeLists(anilistId, providerEpisodes, ctx, expected, offset, availability) {
  const sub = [];
  const dub = [];
  for (const src of providerEpisodes) {
    const sourceNumber = Number(src.number);
    const number = sourceNumber - offset;
    if (!Number.isFinite(number) || number < 1) continue;
    if (expected && number > expected) continue;
    const meta = episodeMeta(number, ctx);
    const base = {
      number,
      title: meta.title ?? `Episode ${number}`,
      duration: meta.duration,
      filler: src.filler ?? meta.filler,
      uncensored: meta.uncensored,
      description: meta.description,
      image: meta.image,
      airDate: meta.airDate,
      sourceNumber,
      sourceId: src.id,
    };
    if (availability.hasSub) sub.push({ ...base, id: `watch/anidbapp/${anilistId}/sub/anidbapp-${number}`, audio: "sub" });
    if (availability.hasDub) dub.push({ ...base, id: `watch/anidbapp/${anilistId}/dub/anidbapp-${number}`, audio: "dub" });
  }
  return { sub, dub };
}

function languageForAudio(languages, audio) {
  const preferred = audio === "sub" ? ["jpn", "ja", "japanese"] : ["eng", "en", "english"];
  return languages.find((l) => preferred.includes(String(l.code ?? "").toLowerCase()))
    ?? languages.find((l) => preferred.includes(String(l.name ?? "").toLowerCase()))
    ?? null;
}

function extractHls(html) {
  const patterns = [
    /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\/master\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m?.[1]) return decodeEntities(m[1]);
  }
  return null;
}

async function streamsForEmbed(embedUrl, audio, language) {
  const html = await fetchAnidbHtml(embedUrl, { Referer: `${BASE}/` }).catch(() => "");
  const hls = html ? extractHls(html) : null;
  const streams = [];
  if (hls) {
    streams.push({
      url: hls,
      type: "hls",
      audio,
      language: language.code,
      server: "AniDB.app",
      embed: embedUrl,
      referer: `${new URL(embedUrl).origin}/`,
      priority: 5,
      isActive: true,
    });
  }
  streams.push({
    url: embedUrl,
    type: "embed",
    audio,
    language: language.code,
    server: "AniDB.app-embed",
    referer: `${BASE}/`,
    priority: 4,
    isActive: !hls,
  });
  return streams;
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  const localCtx = { ...ctx, media };
  const series = await resolveSeries(anilistId, localCtx);
  const episodes = await fetchProviderEpisodes(series.siteId);
  const expected = expectedCount(media, ctx.anizip, ctx.jikanEps);
  const offset = inferOffset(episodes, expected);
  const sampleLanguages = episodes[0]?.id ? await fetchLanguages(episodes[0].id, series.slug) : [];
  const availability = {
    hasSub: hasLanguage(sampleLanguages, "sub") || !sampleLanguages.length,
    hasDub: hasLanguage(sampleLanguages, "dub"),
  };
  return {
    meta: {
      id: series.slug,
      siteId: series.siteId,
      title: series.title,
      source: "anidbapp",
      matchScore: series.matchScore,
      matchType: series.matchType,
      anilistId: series.anilistId,
      malId: series.malId,
      numbering: offset ? "offset" : "local",
      episodeOffset: offset,
    },
    episodes: buildEpisodeLists(anilistId, episodes, localCtx, expected, offset, availability),
  };
}

async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  const series = await resolveSeries(anilistId, ctx);
  const episodes = await fetchProviderEpisodes(series.siteId);
  const media = ctx.media ?? await getMedia(anilistId).catch(() => null);
  const expected = expectedCount(media, ctx.anizip, ctx.jikanEps);
  const offset = inferOffset(episodes, expected);
  const providerEp = Number(epNum) + offset;
  const episode = episodes.find((e) => Number(e.number) === providerEp);
  if (!episode) return json({ error: `AniDB.app episode ${epNum} not found` }, 404);
  const languages = await fetchLanguages(episode.id, series.slug);
  const language = languageForAudio(languages, audio);
  if (!language?.embed_url) {
    return json({ anilistId: Number(anilistId), episode: Number(epNum), providerEpisode: providerEp, audio, streams: [] });
  }
  const embedUrl = decodeEntities(language.embed_url);
  const streams = await streamsForEmbed(embedUrl, audio, language);
  return json({ anilistId: Number(anilistId), episode: Number(epNum), providerEpisode: providerEp, audio, language: language.code, streams });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" } });
    }
    try {
      const m = url.pathname.match(/^\/watch\/anidbapp\/(\d+)\/(sub|dub)\/anidbapp-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, "Raw-ERROR": err.rawBody ?? null, stack: err.stack }, 500);
    }
  },
};
