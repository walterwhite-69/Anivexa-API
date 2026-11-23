import { getMedia } from "../core/anilist.js";
import {
  buildTitleSearchQueries,
  buildTitles,
  episodeMeta,
  json,
  titleIdentityScore,
  titleMarkersConflict,
} from "../core/new-provider-utils.js";
import { del, get, isFresh, set, SHOW_IDENTITY_TTL } from "../core/smartcache.js";

const SITE = "https://pahenime.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

async function fetchJson(url, referer = `${SITE}/`, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: referer,
      ...init.headers,
    },
  });
  const raw = await response.text();
  if (!response.ok) {
    const error = new Error(`Pahenime HTTP ${response.status}: ${url}`);
    error.status = response.status;
    error.rawBody = raw.slice(0, 1200);
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error(`Pahenime returned invalid JSON: ${url}`);
    error.rawBody = raw.slice(0, 1200);
    throw error;
  }
}

function catalogAniListId(item) {
  for (const value of [item?.anilist_id, item?.anilistId, item?.series?.anilist_id]) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) return id;
  }
  try {
    const path = new URL(String(item?.cover_image ?? ""), SITE).pathname;
    const match = path.match(/(?:^|\/)bx(\d+)(?:[-/.]|$)/i);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function candidateTitles(item) {
  return [item?.english_title, item?.name, item?.native_title, item?.romaji_title]
    .filter((value) => typeof value === "string" && value.trim());
}

async function search(query, page = 1) {
  const endpoint = new URL("/api/search", SITE);
  endpoint.search = new URLSearchParams({ q: query, page: String(page) });
  const data = await fetchJson(endpoint.href);
  return {
    results: Array.isArray(data?.data) ? data.data : [],
    totalPages: Math.max(1, Number(data?.pagination?.total_pages) || 1),
  };
}

async function fetchSeries(uuid) {
  const data = await fetchJson(`${SITE}/api/anime/${encodeURIComponent(uuid)}`);
  if (!data?.series || !Array.isArray(data.episodes)) throw new Error("Pahenime returned an incomplete anime record");
  return { series: data.series, episodes: data.episodes };
}

function parseEpisodeNumber(value) {
  const match = String(value ?? "").trim().match(/^(\d+(?:\.\d+)?)(?:\s|$)/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeEpisodeRows(rows) {
  const byNumber = new Map();
  for (const row of rows ?? []) {
    const number = parseEpisodeNumber(row?.episode_number ?? row?.number);
    const id = String(row?.id ?? "").trim();
    if (number === null || !id) continue;
    const item = {
      id,
      number,
      title: String(row?.title ?? row?.name ?? `Episode ${number}`).trim(),
      isDualAudio: row?.is_dual_audio === true,
      raw: row,
    };
    const existing = byNumber.get(number);
    if (!existing || Number(item.isDualAudio) > Number(existing.isDualAudio)) byNumber.set(number, item);
  }
  return [...byNumber.values()].sort((left, right) => left.number - right.number);
}

async function findExactSeries(anilistId, media, anizip) {
  const id = Number(anilistId);
  const cacheKey = `np:pahenime:v1:${id}`;
  const cached = get(cacheKey);
  if (isFresh(cached) && cached.data?.uuid) {
    try {
      const result = await fetchSeries(cached.data.uuid);
      if (Number(result.series.anilist_id) === id) {
        const episodes = normalizeEpisodeRows(result.episodes);
        if (episodes.length) return { ...result, episodes, uuid: String(result.series.uuid ?? cached.data.uuid) };
      }
    } catch {}
    del(cacheKey);
  }

  const titles = buildTitles(media, anizip);
  const queries = buildTitleSearchQueries(titles, 20);
  const candidates = new Map();
  const queryPages = [];
  const searchErrors = [];

  const addResults = (results) => {
    for (const item of results) {
      if (item?.id && !candidates.has(String(item.id))) candidates.set(String(item.id), item);
    }
  };

  for (const query of queries) {
    try {
      const page = await search(query);
      queryPages.push({ query, totalPages: page.totalPages, firstPage: page.results });
      addResults(page.results);
      const exact = page.results.find((item) => catalogAniListId(item) === id);
      if (exact) {
        const result = await fetchSeries(exact.id);
        if (Number(result.series.anilist_id) === id) {
          const episodes = normalizeEpisodeRows(result.episodes);
          if (episodes.length) {
            const resolved = { ...result, episodes, uuid: String(result.series.uuid ?? exact.id) };
            set(cacheKey, { uuid: resolved.uuid }, SHOW_IDENTITY_TTL);
            return resolved;
          }
        }
      }
    } catch (error) {
      searchErrors.push(error);
      if (error.status === 429) break;
    }
  }

  const scoreCandidate = (item) => {
    const itemTitles = candidateTitles(item);
    return titleMarkersConflict(titles, itemTitles, media?.format)
      ? 0
      : titleIdentityScore(titles, itemTitles);
  };
  const ranked = [...candidates.values()].map((item) => ({ item, score: scoreCandidate(item) }))
    .filter((candidate) => candidate.score >= 0.42)
    .sort((left, right) => right.score - left.score);

  const verify = async (item) => {
    try {
      const result = await fetchSeries(item.id);
      if (Number(result.series.anilist_id) !== id) return null;
      const episodes = normalizeEpisodeRows(result.episodes);
      if (!episodes.length) return null;
      const resolved = { ...result, episodes, uuid: String(result.series.uuid ?? item.id) };
      set(cacheKey, { uuid: resolved.uuid }, SHOW_IDENTITY_TTL);
      return resolved;
    } catch {
      return null;
    }
  };

  for (const { item } of ranked) {
    const result = await verify(item);
    if (result) return result;
  }

  for (const { query, totalPages, firstPage } of queryPages) {
    if (totalPages < 2 || !firstPage.some((item) => scoreCandidate(item) >= 0.42)) continue;
    for (let pageNumber = 2; pageNumber <= totalPages; pageNumber++) {
      try {
        const page = await search(query, pageNumber);
        addResults(page.results);
        const exact = page.results.find((item) => catalogAniListId(item) === id);
        if (exact) {
          const result = await verify(exact);
          if (result) return result;
        }
        const pageCandidates = page.results
          .map((item) => ({ item, score: scoreCandidate(item) }))
          .filter((candidate) => candidate.score >= 0.42)
          .sort((left, right) => right.score - left.score);
        for (const { item } of pageCandidates) {
          const result = await verify(item);
          if (result) return result;
        }
      } catch (error) {
        searchErrors.push(error);
        if (error.status === 429) break;
      }
    }
  }

  const rateLimit = searchErrors.find((error) => error.status === 429);
  if (rateLimit) throw rateLimit;
  throw new Error(`Pahenime has no verified catalog match for AniList ${id}`);
}

function episodeLists(anilistId, episodes, ctx) {
  const sub = [];
  const dub = [];
  for (const episode of episodes) {
    const meta = episodeMeta(episode.number, ctx);
    const base = {
      number: episode.number,
      title: meta.title ?? episode.title,
      duration: meta.duration,
      filler: meta.filler,
      uncensored: false,
      description: meta.description,
      image: meta.image ?? episode.raw.thumbnail ?? null,
      airDate: meta.airDate,
    };
    sub.push({
      id: `watch/pahenime/${anilistId}/sub/pahenime-${episode.number}`,
      ...base,
      audio: "sub",
    });
    if (episode.isDualAudio) {
      dub.push({
        id: `watch/pahenime/${anilistId}/dub/pahenime-${episode.number}`,
        ...base,
        audio: "dub",
      });
    }
  }
  return { sub, dub };
}

async function playbackSource(episode, audio, playerUrl) {
  const metadata = await fetchJson(`${SITE}/stream/metadata/${encodeURIComponent(episode.id)}`, playerUrl);
  const tracks = Array.isArray(metadata.audioTracks) ? metadata.audioTracks : [];
  const wantedLanguage = audio === "dub" ? /^(en|eng|english)$/i : /^(ja|jpn|jp|japanese)$/i;
  const audioTrack = tracks.find((track) => wantedLanguage.test(String(track.lang ?? track.language ?? "")))
    ?? (audio === "sub" ? tracks[0] : null);
  const qualities = Array.isArray(metadata.resolutions) ? metadata.resolutions : [];
  const quality = [...qualities].sort((left, right) => {
    const leftValue = Number(String(left.quality ?? "").match(/\d+(?:\.\d+)?/)?.[0]) || 0;
    const rightValue = Number(String(right.quality ?? "").match(/\d+(?:\.\d+)?/)?.[0]) || 0;
    return rightValue - leftValue;
  })[0]?.quality;
  const servers = Array.isArray(metadata.servers) ? metadata.servers : [];
  if (!audioTrack || !quality) return null;

  for (const server of servers) {
    if (typeof server?.url !== "string") continue;
    const response = await fetchJson(`${SITE}/stream/start/${encodeURIComponent(episode.id)}`, playerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({
        quality,
        audioIndex: Number(audioTrack.index) || 0,
        serverUrl: server.url,
      }),
    }).catch(() => null);
    let sourceUrl;
    try {
      sourceUrl = new URL(response?.streamUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(sourceUrl.protocol)) continue;

    const manifestResponse = await fetch(sourceUrl.href, {
      headers: {
        "User-Agent": UA,
        Accept: "*/*",
        Referer: playerUrl,
        Range: "bytes=0-65535",
      },
    }).catch(() => null);
    if (!manifestResponse?.ok) continue;
    const rawManifest = Buffer.from(await manifestResponse.arrayBuffer());
    const manifestOffset = rawManifest.indexOf(Buffer.from("#EXTM3U"));
    if (manifestOffset < 0) continue;
    const manifest = rawManifest.subarray(manifestOffset).toString("utf8");
    const firstUri = manifest.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
    let segmentOffset = null;

    if (firstUri) {
      const segmentUrl = new URL(firstUri, sourceUrl);
      const segmentResponse = await fetch(segmentUrl, {
        headers: {
          "User-Agent": UA,
          Accept: "*/*",
          Referer: playerUrl,
          Range: "bytes=0-255",
        },
      }).catch(() => null);
      if (segmentResponse?.ok) {
        const rawSegment = Buffer.from(await segmentResponse.arrayBuffer());
        const box = rawSegment.toString("latin1").match(/(?:ftyp|styp|moof|moov|sidx)/);
        if (box && box.index >= 4) {
          const offset = box.index - 4;
          const size = rawSegment.readUInt32BE(offset);
          if (size >= 8 && offset + 8 <= rawSegment.length) segmentOffset = offset;
        }
      }
    }

    return {
      url: sourceUrl.href,
      server: String(server.name ?? "Pahenime"),
      quality: String(quality),
      audioTrack: {
        index: Number(audioTrack.index) || 0,
        language: String(audioTrack.lang ?? audioTrack.language ?? ""),
      },
      wrapperOffsets: { manifest: manifestOffset, segment: segmentOffset },
    };
  }
  return null;
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  if (!media) throw new Error(`Could not resolve AniList ID ${anilistId}`);
  const result = await findExactSeries(anilistId, media, ctx.anizip);
  return {
    meta: {
      id: result.uuid,
      title: result.series.english_title ?? result.series.name ?? null,
      malId: result.series.mal_id ?? media.idMal ?? null,
      source: "pahenime",
    },
    episodes: episodeLists(anilistId, result.episodes, { ...ctx, media }),
  };
}

async function handleWatch(anilistId, audio, episodeNumber) {
  if (audio !== "sub" && audio !== "dub") return json({ error: "audio must be sub or dub" }, 400);
  const media = await getMedia(anilistId);
  if (!media) return json({ error: `Could not resolve AniList ID ${anilistId}` }, 400);
  const result = await findExactSeries(anilistId, media, null);
  const episode = result.episodes.find((item) => item.number === Number(episodeNumber));
  if (!episode || audio === "dub" && !episode.isDualAudio) {
    return json({ error: `Pahenime ${audio} episode ${episodeNumber} not found` }, 404);
  }

  const player = new URL("/player", SITE);
  player.searchParams.set("id", episode.id);
  const streams = [{
    url: player.href,
    type: "embed",
    server: "Pahenime",
    referer: `${SITE}/`,
    priority: 5,
    isActive: true,
  }];

  try {
    const source = await playbackSource(episode, audio, player.href);
    if (source) streams.push({
      url: source.url,
      type: "hls",
      server: source.server,
      referer: player.href,
      priority: 4,
      isActive: false,
      quality: source.quality,
      audioTrack: source.audioTrack,
      wrappedFormat: "image-wrapped-hls",
      wrapperOffsets: source.wrapperOffsets,
    });
  } catch {}

  return json({
    anilistId: Number(anilistId),
    episode: Number(episodeNumber),
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

    const path = new URL(request.url).pathname;
    let match = path.match(/^\/watch\/pahenime\/(\d+)\/(sub|dub)\/pahenime-(\d+(?:\.\d+)?)\/?$/);
    try {
      if (match) return await handleWatch(match[1], match[2], match[3]);
      match = path.match(/^\/episodes\/pahenime\/(\d+)\/?$/);
      if (match) return json(await getEpisodes(Number(match[1])));
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message, "Raw-ERROR": error.rawBody ?? null, stack: error.stack }, error.status ?? 500);
    }
  },
};
