import { getMedia } from "../core/anilist.js";
import {
  attr,
  buildTitleSearchQueries,
  buildTitles,
  decodeEntities,
  episodeMeta,
  json,
  stripTags,
  titleIdentityScore,
  titleMarkersConflict,
  titleScore,
} from "../core/new-provider-utils.js";
import { findVideoExtractor } from "../extractors/index.js";
import { get, set, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";

const SITE = "https://anihq.cc";
const REST = `${SITE}/wp-json/wp/v2`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

let nonceValue = null;
let nonceFetchedAt = 0;
let nonceInFlight = null;

function audioLabel(audio) {
  return audio === "dub" ? "dubbed" : "subbed";
}

function removeAudioLabel(value) {
  return String(value ?? "")
    .replace(/\s+english\s+(?:subbed|dubbed)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(url, referer = `${SITE}/`) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: referer,
    },
    redirect: "follow",
  });
  const raw = await response.text();
  if (!response.ok) {
    const error = new Error(`AniHQ HTTP ${response.status}: ${url}`);
    error.status = response.status;
    error.rawBody = raw.slice(0, 1200);
    throw error;
  }
  return { html: raw, url: response.url || url };
}

async function getSearchNonce(force = false) {
  if (!force && nonceValue && Date.now() - nonceFetchedAt < 5 * 60_000) return nonceValue;
  if (!nonceInFlight) {
    nonceInFlight = fetchHtml(`${SITE}/`)
      .then(({ html }) => {
        const match = html.match(/search_actions\\?["']\s*:\s*\\?["']([a-z0-9_-]+)\\?["']/i);
        if (!match) throw new Error("AniHQ search nonce not found on homepage");
        nonceValue = match[1];
        nonceFetchedAt = Date.now();
        return nonceValue;
      })
      .finally(() => {
        nonceInFlight = null;
      });
  }
  return nonceInFlight;
}

function parseSearchResults(html) {
  const candidates = [];
  for (const match of String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = match[1];
    const href = attr(attributes, "href");
    if (!href) continue;
    let url;
    try {
      url = new URL(decodeEntities(href), SITE);
    } catch {
      continue;
    }
    if (url.origin !== SITE || !url.pathname.startsWith("/anime-show/")) continue;
    const slug = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const audioMatch = slug.match(/-english-(subbed|dubbed)$/i);
    const audio = audioMatch ? audioMatch[1].toLowerCase() === "dubbed" ? "dub" : "sub" : null;
    const baseSlug = slug.replace(/-english-(?:subbed|dubbed)$/i, "");
    const titleValues = [removeAudioLabel(attr(attributes, "title"))];
    for (const span of match[2].matchAll(/<span\b[^>]*class=["'][^"']*group-data-\[language=[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)) {
      const title = removeAudioLabel(stripTags(span[1]));
      if (title) titleValues.push(title);
    }
    titleValues.push(baseSlug.replace(/-/g, " "));
    const titles = [...new Set(titleValues.filter(Boolean))];
    if (!titles.length) continue;
    candidates.push({
      url: `${url.origin}${url.pathname}`,
      slug,
      baseSlug,
      audio,
      title: titles[0],
      titles,
    });
  }
  return candidates;
}

async function search(query, retry = true) {
  const nonce = await getSearchNonce();
  const endpoint = new URL("/wp-admin/admin-ajax.php", SITE);
  endpoint.search = new URLSearchParams({ action: "instant_search", query, nonce });
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      Referer: `${SITE}/`,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  const raw = await response.text();
  if ((response.status === 401 || response.status === 403) && retry) {
    await getSearchNonce(true);
    return search(query, false);
  }
  if (!response.ok) {
    const error = new Error(`AniHQ search HTTP ${response.status}: ${query}`);
    error.rawBody = raw.slice(0, 1200);
    throw error;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const error = new Error(`AniHQ search returned invalid JSON: ${query}`);
    error.rawBody = raw.slice(0, 1200);
    throw error;
  }
  if (data?.success !== true || typeof data?.data?.html !== "string") return [];
  return parseSearchResults(data.data.html);
}

function scoreCandidate(candidate, media, allTitles) {
  if (titleMarkersConflict(allTitles, candidate.titles, media?.format, { allowMissing: true })) return null;
  const identity = titleIdentityScore(allTitles, candidate.titles);
  const lexical = Math.max(...allTitles.map((title) => titleScore(title, candidate.title, candidate.baseSlug)));
  if (identity < 0.6 || lexical < 0.5) return null;
  return { ...candidate, identity, lexical, score: identity * 0.65 + lexical * 0.35 };
}

async function fetchAnimePost(candidate) {
  const endpoint = new URL(`${REST}/anime`);
  endpoint.search = new URLSearchParams({ slug: candidate.baseSlug });
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: `${SITE}/`,
    },
  });
  const raw = await response.text();
  if (!response.ok && ![401, 403].includes(response.status)) {
    const error = new Error(`AniHQ anime lookup HTTP ${response.status}: ${candidate.url}`);
    error.status = response.status;
    error.rawBody = raw.slice(0, 1200);
    throw error;
  }

  if (response.ok) {
    let posts;
    try {
      posts = JSON.parse(raw);
    } catch {}
    const post = Array.isArray(posts) ? posts.find((item) => item?.slug === candidate.baseSlug) : null;
    if (post?.id) {
      const classes = new Set(Array.isArray(post.class_list) ? post.class_list : []);
      return {
        id: String(post.id),
        hasSub: classes.has("anime_attribute-sub"),
        hasDub: classes.has("anime_attribute-dub"),
      };
    }
  }

  const { html } = await fetchHtml(candidate.url);
  return parseAnimePostPage(candidate, html);
}

export function parseAnimePostPage(candidate, html) {
  const bodyAttributes = String(html).match(/<body\b([^>]*)>/i)?.[1] ?? "";
  const bodyClasses = attr(bodyAttributes, "class") ?? "";
  const postId = bodyClasses.match(/\bpostid-(\d+)\b/)?.[1] ??
    String(html).match(/\bdata-post-id=["'](\d+)["']/i)?.[1];
  if (!postId) return null;

  const hasSubMarker = /anime_attribute-sub|English\s+Sub(?:bed)?/i.test(html);
  const hasDubMarker = /anime_attribute-dub|English\s+Dub(?:bed)?/i.test(html);
  const hasAudioMarkers = hasSubMarker || hasDubMarker;
  return {
    id: postId,
    hasSub: hasAudioMarkers ? hasSubMarker : candidate.audio !== "dub",
    hasDub: hasAudioMarkers ? hasDubMarker : candidate.audio !== "sub",
  };
}

async function fetchEpisodePage(candidate, seasonId, page) {
  const endpoint = new URL("/wp-admin/admin-ajax.php", SITE);
  endpoint.search = new URLSearchParams({
    action: "get_episodes",
    anime_id: seasonId,
    page: String(page),
    order: "desc",
  });
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      Referer: candidate.url,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`AniHQ episode list HTTP ${response.status}: ${candidate.url}`);
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(`AniHQ episode list returned invalid JSON: ${candidate.url}`);
  }
  if (result?.success !== true || !Array.isArray(result?.data?.episodes)) {
    throw new Error(`AniHQ episode list has an unexpected response: ${candidate.url}`);
  }
  return result.data;
}

function mapEpisodeRows(rows, candidate) {
  const episodes = new Map();
  for (const item of rows) {
    const number = Number(item?.meta_number ?? String(item?.number ?? "").match(/\d+(?:\.\d+)?/)?.[0]);
    if (!Number.isFinite(number) || number < 1) continue;
    let url;
    try {
      url = new URL(decodeEntities(item.url ?? ""), candidate.url);
    } catch {
      continue;
    }
    if (url.origin !== SITE || !url.pathname.startsWith("/watch/")) continue;
    episodes.set(number, {
      number,
      title: removeAudioLabel(item.post_title ?? item.title) || `Episode ${number}`,
      watchUrl: `${url.origin}${url.pathname}`,
    });
  }
  return episodes;
}

async function fetchEpisodes(candidate, animeId) {
  const first = await fetchEpisodePage(candidate, animeId, 1);
  const maxPages = Number(first.max_episodes_page);
  if (!Number.isInteger(maxPages) || maxPages < 0 || maxPages > 100) {
    throw new Error(`AniHQ episode page count is invalid: ${candidate.url}`);
  }
  const episodes = mapEpisodeRows(first.episodes, candidate);
  for (let start = 2; start <= Math.max(1, maxPages); start += 4) {
    const pages = Array.from({ length: Math.min(4, Math.max(1, maxPages) - start + 1) }, (_, index) => start + index);
    const results = await Promise.all(pages.map((page) => fetchEpisodePage(candidate, animeId, page)));
    for (const result of results) {
      for (const [number, episode] of mapEpisodeRows(result.episodes, candidate)) episodes.set(number, episode);
    }
  }
  return [...episodes.values()].sort((left, right) => left.number - right.number);
}

async function inspectCandidate(candidate) {
  try {
    const anime = await fetchAnimePost(candidate);
    if (!anime) return null;
    const episodes = await fetchEpisodes(candidate, anime.id);
    if (!episodes.length) return null;
    return { ...candidate, episodes, audioCapabilities: { sub: anime.hasSub, dub: anime.hasDub } };
  } catch {
    return null;
  }
}

async function inspectAudioVariant(audio, candidates) {
  const ranked = candidates
    .filter((candidate) => !candidate.audio || candidate.audio === audio)
    .sort((left, right) => right.score - left.score || right.identity - left.identity)
    .slice(0, 6);
  if (!ranked.length) return null;
  const inspected = (await Promise.all(ranked.map(inspectCandidate))).filter(Boolean)
    .filter((candidate) => candidate.audioCapabilities[audio])
    .sort((left, right) => right.score - left.score || right.episodes.length - left.episodes.length);
  const selected = inspected[0];
  const runnerUp = inspected[1];
  if (!selected || (runnerUp && selected.score - runnerUp.score < 0.06 && selected.baseSlug !== runnerUp.baseSlug)) return null;
  return selected;
}

async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:anihq:v3:${anilistId}`;
  const cached = get(cacheKey);
  if (isFresh(cached)) return cached.data;

  const media = ctx.media ?? await getMedia(anilistId);
  const primaryTitles = [media?.title?.english, media?.title?.romaji, media?.title?.native].filter(Boolean);
  const allTitles = [...new Set(buildTitles(media, ctx.anizip).filter(Boolean))];
  if (!primaryTitles.length || !allTitles.length) throw new Error(`AniHQ has no AniList titles for ${anilistId}`);

  const candidates = new Map();
  let searchError = null;
  const queries = buildTitleSearchQueries(allTitles, 18);
  for (let index = 0; index < queries.length; index += 4) {
    const batch = await Promise.all(queries.slice(index, index + 4).map(async (query) => {
      try {
        return await search(query);
      } catch (error) {
        searchError ??= error;
        return [];
      }
    }));
    for (const results of batch) {
      for (const candidate of results) {
        const scored = scoreCandidate(candidate, media, allTitles);
        if (scored && !candidates.has(candidate.slug)) candidates.set(candidate.slug, scored);
      }
    }
  }

  const ranked = [...candidates.values()];
  const [sub, dub] = await Promise.all([
    inspectAudioVariant("sub", ranked),
    inspectAudioVariant("dub", ranked),
  ]);
  if (!sub && !dub) {
    const detail = searchError ? `: ${searchError.message}` : "";
    throw new Error(`AniHQ could not confidently match AniList ${anilistId}${detail}`);
  }

  const data = {
    title: media.title?.english ?? media.title?.romaji ?? media.title?.native ?? null,
    variants: { sub, dub },
  };
  set(cacheKey, data, SHOW_IDENTITY_TTL);
  return data;
}

function episodeList(anilistId, audio, variant, ctx) {
  if (!variant) return [];
  return variant.episodes.map((episode) => {
    const meta = episodeMeta(episode.number, ctx);
    return {
      id: `watch/anihq/${anilistId}/${audio}/anihq-${episode.number}`,
      number: episode.number,
      title: meta.title ?? episode.title ?? `Episode ${episode.number}`,
      duration: meta.duration,
      audio,
      filler: meta.filler,
      uncensored: false,
      description: meta.description,
      image: meta.image,
      airDate: meta.airDate,
    };
  });
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  const localCtx = { ...ctx, media };
  const series = await resolveSeries(anilistId, localCtx);
  const sub = episodeList(anilistId, "sub", series.variants.sub, localCtx);
  const dub = episodeList(anilistId, "dub", series.variants.dub, localCtx);
  if (!sub.length && !dub.length) throw new Error(`AniHQ has no episodes for AniList ${anilistId}`);
  return {
    meta: {
      id: series.variants.sub?.slug ?? series.variants.dub?.slug,
      title: series.title,
    },
    episodes: { sub, dub, raw: [] },
  };
}

function watchEmbed(html, referer) {
  const embeds = [];
  for (const match of String(html).matchAll(/<iframe\b([^>]*)>/gi)) {
    for (const source of [attr(match[1], "src"), attr(match[1], "data-src"), attr(match[1], "data-lazy-src"), attr(match[1], "data-aniturbo-src")]) {
      if (!source) continue;
      try {
        const url = new URL(decodeEntities(source), referer);
        if ((url.protocol === "https:" || url.protocol === "http:") && !embeds.includes(url.href)) embeds.push(url.href);
      } catch {}
    }
  }
  return embeds.find((url) => findVideoExtractor(url)) ?? embeds[0] ?? null;
}

async function handleWatch(anilistId, audio, epNum) {
  const media = await getMedia(anilistId);
  const series = await resolveSeries(anilistId, { media });
  const variant = series.variants[audio];
  const episode = variant?.episodes.find((item) => item.number === Number(epNum));
  if (!episode) return json({ error: `AniHQ ${audio} episode ${epNum} not found` }, 404);

  const { html } = await fetchHtml(episode.watchUrl, variant.url);
  const embedUrl = watchEmbed(html, episode.watchUrl);
  if (!embedUrl) throw new Error(`AniHQ has no player embed for ${audio} episode ${epNum}`);

  const extractor = findVideoExtractor(embedUrl);
  const embedOrigin = `${new URL(embedUrl).origin}/`;
  const streams = [];
  if (extractor) {
    try {
      const extracted = await extractor.extract(embedUrl, { userAgent: UA, referer: episode.watchUrl });
      for (const result of extracted) {
        const source = typeof result === "string" ? { url: result, type: "hls" } : result;
        if (!source?.url) continue;
        streams.push({
          url: source.url,
          type: source.type ?? "hls",
          server: source.server ?? extractor.name,
          referer: source.referer ?? `${new URL(embedUrl).origin}/`,
          embed: embedUrl,
          subtitles: source.subtitles ?? [],
          priority: 5,
          isActive: streams.length === 0,
        });
      }
    } catch {}
  }
  streams.push({
    url: embedUrl,
    type: "embed",
    server: extractor?.name === "voe" ? "VOE" : extractor?.name ?? new URL(embedUrl).hostname,
    referer: embedOrigin,
    priority: streams.length ? 4 : 5,
    isActive: streams.length === 0,
  });

  return json({
    anilistId: Number(anilistId),
    episode: Number(epNum),
    providerEpisode: episode.number,
    audio,
    intro: null,
    outro: null,
    streams,
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }
    const match = new URL(request.url).pathname.match(/^\/watch\/anihq\/(\d+)\/(sub|dub)\/anihq-(\d+(?:\.\d+)?)\/?$/);
    if (!match) return json({ error: "Not found" }, 404);
    try {
      return await handleWatch(match[1], match[2], match[3]);
    } catch (error) {
      return json({ error: error.message, "Raw-ERROR": error.rawBody ?? null, stack: error.stack }, error.status ?? 500);
    }
  },
};
