import { getMedia } from "../core/anilist.js";
import {
  attr,
  buildTitles,
  decodeEntities,
  episodeMeta,
  expectedCount,
  fetchHtml,
  findTopSlugs,
  getPrequelOffset,
  json,
  selectSeries,
  stripTags,
} from "../core/new-provider-utils.js";
import { get, set, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";

const BASE = "https://anineko.to";

async function search(query) {
  const html = await fetchHtml(`${BASE}/browser?keyword=${encodeURIComponent(query)}`);
  const results = [];
  for (const m of html.matchAll(/<a\b[^>]*class=["'][^"']*nv-anime-thumb[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = m[0].match(/<a\b[^>]*>/i)?.[0] ?? "";
    const href = attr(tag, "href");
    const slug = href.match(/\/watch\/([^/?#]+)/)?.[1];
    if (!slug) continue;
    const titleMatch = m[0].match(/<(?:h3|[^>]+class=["'][^"']*nv-anime-title[^"']*["'][^>]*)>([\s\S]*?)<\/(?:h3|[^>]+)>/i);
    results.push({ slug, text: titleMatch ? stripTags(titleMatch[1]) : slug.replace(/-/g, " ") });
  }
  return results;
}

async function scrapeSeries(slug) {
  const html = await fetchHtml(`${BASE}/watch/${slug}`);
  const episodes = [];
  for (const m of html.matchAll(/<article\b[^>]*class=["'][^"']*nv-info-episode-item[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)) {
    const block = m[1];
    const link = block.match(/<a\b[^>]*class=["'][^"']*nv-info-episode-main[^"']*["'][^>]*>/i)?.[0] ?? "";
    const href = attr(link, "href");
    const num = Number(href.match(/\/ep-(\d+)/)?.[1]);
    if (!Number.isFinite(num)) continue;
    const title = stripTags(block.match(/<a\b[^>]*class=["'][^"']*nv-info-episode-main[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
    const badges = [...block.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((b) => stripTags(b[1]).toLowerCase());
    episodes.push({
      number: num,
      title: title || `Episode ${num}`,
      epSlug: `ep-${num}`,
      hasSub: badges.includes("sub"),
      hasDub: badges.includes("dub"),
    });
  }
  episodes.sort((a, b) => a.number - b.number);
  const seen = new Set();
  return episodes.filter((e) => seen.has(e.number) ? false : (seen.add(e.number), true));
}

async function extractHls(embedUrl) {
  const html = await fetchHtml(embedUrl, { Referer: `${BASE}/` }).catch(() => "");
  const patterns = [
    /const\s+src\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\/master\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) return decodeEntities(m[1]);
  }
  return null;
}

async function scrapeEpisodeWatch(seriesSlug, epSlug, audio) {
  const html = await fetchHtml(`${BASE}/watch/${seriesSlug}/${epSlug}`, { Referer: `${BASE}/watch/${seriesSlug}` });
  const byAudio = { sub: [], dub: [] };
  for (const panel of html.matchAll(/<div\b[^>]*class=["'][^"']*nv-server-grid[^"']*["'][^>]*data-id=["']([^"']+)["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*nv-server-grid|$)/gi)) {
    const rawAudio = panel[1].toLowerCase();
    const panelAudio = rawAudio.includes("dub") ? "dub" : "sub";
    for (const btn of panel[2].matchAll(/data-video=["']([^"']+)["']/gi)) byAudio[panelAudio].push(decodeEntities(btn[1]));
  }
  const audios = audio === "all" ? ["sub", "dub"] : [audio];
  const streams = [];
  await Promise.all(audios.map(async (aud) => {
    const embeds = byAudio[aud] ?? [];
    const resolved = await Promise.all(embeds.map(async (embed, i) => {
      const hls = await extractHls(embed);
      return {
        url: hls ?? embed,
        type: hls ? "hls" : "embed",
        embed,
        audio: aud,
        server: "AniNeko",
        priority: embeds.length - i,
        referer: `${new URL(embed).origin}/`,
        isActive: i === 0,
      };
    }));
    streams.push(...resolved);
  }));
  return streams;
}

async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:anineko:${anilistId}`;
  const cached = get(cacheKey);
  if (isFresh(cached)) return cached.data;

  const media = ctx.media ?? await getMedia(anilistId);
  const titles = buildTitles(media, ctx.anizip);
  const candidates = await findTopSlugs(titles, search);
  const expected = expectedCount(media, ctx.anizip, ctx.jikanEps);
  const offset = await getPrequelOffset(anilistId).catch(() => 0);
  const selected = await selectSeries(candidates, scrapeSeries, expected, media?.status, offset);
  if (!selected) throw new Error(`AniNeko match not found for AniList ${anilistId}`);
  const data = { slug: selected.slug, title: selected.title, mode: selected.mode, offset, score: selected.score };
  set(cacheKey, data, SHOW_IDENTITY_TTL);
  return data;
}

function buildEpisodeLists(anilistId, series, providerEpisodes, ctx, expected) {
  const sub = [], dub = [];
  for (const src of providerEpisodes) {
    const number = series.mode === "offset" ? src.number - series.offset : src.number;
    if (number < 1) continue;
    if (expected && number > expected) continue;
    const meta = episodeMeta(number, ctx);
    const base = {
      number,
      title: meta.title ?? src.title ?? `Episode ${number}`,
      duration: meta.duration,
      filler: meta.filler,
      uncensored: meta.uncensored,
      description: meta.description,
      image: meta.image,
      airDate: meta.airDate,
      sourceNumber: src.number,
    };
    if (src.hasSub) sub.push({ id: `watch/anineko/${anilistId}/sub/anineko-${number}`, ...base, audio: "sub" });
    if (src.hasDub) dub.push({ id: `watch/anineko/${anilistId}/dub/anineko-${number}`, ...base, audio: "dub" });
  }
  return { sub, dub };
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  const localCtx = { ...ctx, media };
  const series = await resolveSeries(anilistId, localCtx);
  const episodes = await scrapeSeries(series.slug);
  const expected = expectedCount(media, ctx.anizip, ctx.jikanEps);
  return {
    meta: {
      id: series.slug,
      title: series.title,
      source: "anineko",
      matchScore: Number(series.score.toFixed(3)),
      numbering: series.mode,
      episodeOffset: series.mode === "offset" ? series.offset : 0,
    },
    episodes: buildEpisodeLists(anilistId, series, episodes, localCtx, expected),
  };
}

async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  const series = await resolveSeries(anilistId, ctx);
  const providerEp = series.mode === "offset" ? Number(epNum) + series.offset : Number(epNum);
  const streams = await scrapeEpisodeWatch(series.slug, `ep-${providerEp}`, audio);
  return json({ anilistId: Number(anilistId), episode: Number(epNum), providerEpisode: providerEp, audio, streams });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" } });
    }
    try {
      const m = url.pathname.match(/^\/watch\/anineko\/(\d+)\/(sub|dub)\/anineko-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, "Raw-ERROR": err.rawBody ?? null, stack: err.stack }, 500);
    }
  },
};
