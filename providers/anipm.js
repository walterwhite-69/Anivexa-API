import { getMedia } from "../core/anilist.js";
import { buildTitleSearchQueries, buildTitles, episodeMeta, json } from "../core/new-provider-utils.js";
import { get, set, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";
import { wreqFetch } from "../core/wreq.js";

const SITE = "https://anipm.pk";
const EMBED = "https://embed.settlar.io";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const BROWSER = process.env.ANIPM_WREQ_BROWSER || "chrome_149";
const OS = process.env.ANIPM_WREQ_OS || "windows";

function requestHeaders(referer = `${SITE}/`) {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    Referer: referer,
    Origin: new URL(referer).origin,
  };
}

async function wreq(url, options = {}) {
  return wreqFetch(url, {
    session: "anipm",
    browser: BROWSER,
    os: OS,
    ...options,
  });
}

async function requestJson(url, referer = `${SITE}/`) {
  const response = await wreq(url, { headers: requestHeaders(referer) });
  const raw = await response.text();
  if (!response.ok) {
    const error = new Error(`Ani.pm HTTP ${response.status}: ${raw.slice(0, 400)}`);
    error.status = response.status;
    error.rawBody = raw.slice(0, 2000);
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Ani.pm returned invalid JSON");
    error.rawBody = raw.slice(0, 2000);
    throw error;
  }
}

function titleVariants(media, anizip) {
  return [...new Set(buildTitles(media, anizip).map((value) => String(value).trim()).filter(Boolean))];
}

function identityMatches(candidate, media) {
  const aid = Number(candidate?.anilistId) || null;
  const mal = Number(candidate?.malId) || null;
  const expectedAid = Number(media?.id) || null;
  const expectedMal = Number(media?.idMal) || null;
  if (aid && expectedAid && aid !== expectedAid) return false;
  if (mal && expectedMal && mal !== expectedMal) return false;
  return Boolean((aid && expectedAid && aid === expectedAid) || (mal && expectedMal && mal === expectedMal));
}

function verifyBootstrap(data, media) {
  const core = data?.core ?? data?.anime ?? data?.data?.core;
  if (!core) throw new Error("Ani.pm bootstrap did not include anime metadata");
  const aid = Number(core.anilistId) || null;
  const mal = Number(core.malId) || null;
  const expectedAid = Number(media?.id) || null;
  const expectedMal = Number(media?.idMal) || null;
  if (!(aid && expectedAid && aid === expectedAid) && !(mal && expectedMal && mal === expectedMal)) {
    throw new Error(`Ani.pm bootstrap identity mismatch for AniList ${expectedAid}`);
  }
  if (aid && expectedAid && aid !== expectedAid) throw new Error(`Ani.pm AniList identity mismatch for ${expectedAid}`);
  if (mal && expectedMal && mal !== expectedMal) throw new Error(`Ani.pm MAL identity mismatch for ${expectedMal}`);
  return core;
}

async function bootstrap(series, episode, audio) {
  const language = audio === "dub" ? "dub" : "sub";
  const url = new URL(`/api/anime/playback-bootstrap/${encodeURIComponent(series.source)}/${encodeURIComponent(series.id)}`, SITE);
  url.searchParams.set("ep", String(episode));
  url.searchParams.set("lang", language);
  url.searchParams.set("routes", "e4");
  return requestJson(url.href);
}

async function resolveSeries(anilistId, ctx = {}) {
  const key = `np:match3:anipm:${anilistId}`;
  const cached = get(key);
  if (isFresh(cached)) return cached.data;
  const media = ctx.media ?? await getMedia(anilistId);
  const titles = titleVariants(media, ctx.anizip);
  if (!titles.length) throw new Error(`Ani.pm has no AniList titles for ${anilistId}`);
  const candidates = new Map();
  const queries = buildTitleSearchQueries(titles, 16);
  for (let index = 0; index < queries.length; index += 4) {
    const batches = await Promise.all(queries.slice(index, index + 4).map(async (title) => {
      try {
        const url = new URL("/api/anime/search", SITE);
        url.searchParams.set("q", title);
        const result = await requestJson(url.href);
        return Array.isArray(result) ? result : result?.items ?? result?.results ?? result?.data ?? [];
      } catch {
        return [];
      }
    }));
    for (const items of batches) {
      for (const item of items) {
        if (item?.id && identityMatches(item, media)) {
          const source = String(item.source || item.provider || "");
          const sourceId = source.toLowerCase() === "anilist"
            ? Number(item.anilistId ?? item.anilist_id) || item.id
            : item.id;
          if (source) candidates.set(`${source}:${sourceId}`, { id: String(sourceId), source, title: item.title || item.name || "" });
        }
      }
    }
  }
  for (const candidate of candidates.values()) {
    for (const episode of [1]) {
      try {
        const data = await bootstrap(candidate, episode, "sub");
        const core = verifyBootstrap(data, media);
        const episodes = Array.isArray(core.episodes) ? core.episodes : [];
        const series = {
          ...candidate,
          title: core.title || candidate.title,
          episodes,
          packages: data.anipmPackages?.episodes ?? data.packages?.episodes ?? {},
        };
        if (!episodes.length) continue;
        set(key, series, SHOW_IDENTITY_TTL);
        return series;
      } catch {}
    }
  }
  throw new Error(`Ani.pm could not confidently map AniList ${anilistId}`);
}

function episodeNumber(item) {
  return Number(item?.number ?? item?.episode ?? item?.ep ?? item?.id);
}

function hasChannel(series, number, audio, hard = false) {
  const info = series.packages?.[String(number)];
  const flag = `${audio}${hard ? "hard" : ""}`;
  return info?.[flag] === true;
}

function episodeList(anilistId, series, audio, ctx) {
  return series.episodes
    .filter((item) => Number.isInteger(episodeNumber(item)) && hasChannel(series, episodeNumber(item), audio))
    .map((item) => {
      const number = episodeNumber(item);
      const meta = episodeMeta(number, ctx);
      return {
        id: `watch/anipm/${anilistId}/${audio}/anipm-${number}`,
        number,
        sourceNumber: String(item.number ?? item.episode ?? item.ep ?? number),
        title: meta.title ?? item.title ?? `Episode ${number}`,
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
  const series = await resolveSeries(anilistId, { ...ctx, media });
  const sub = episodeList(anilistId, series, "sub", ctx);
  const dub = episodeList(anilistId, series, "dub", ctx);
  if (!sub.length && !dub.length) throw new Error(`Ani.pm has no episodes for AniList ${anilistId}`);
  return {
    meta: { id: series.id, title: series.title, source: "anipm", numbering: "standard", episodeOffset: 0 },
    episodes: { sub, dub },
  };
}

function mapSubtitles(items, referer) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (typeof item === "string") return { url: item, label: "Subtitle", srclang: "und", headers: { Referer: referer } };
    const url = item?.url ?? item?.src ?? item?.file;
    if (!url) return null;
    return {
      url,
      label: item.label ?? item.lang ?? item.language ?? "Subtitle",
      srclang: item.srclang ?? item.lang ?? item.language ?? "und",
      default: Boolean(item.default),
      headers: { Referer: referer },
    };
  }).filter(Boolean);
}

function playbackSources(data, embedData, embedUrl) {
  const variants = [];
  const add = (value, label = "") => {
    const item = typeof value === "string" ? { url: value } : value;
    if (!item || typeof item !== "object") return;
    const source = item.url ?? item.src ?? item.file ?? item.source ?? item.streamUrl;
    if (typeof source !== "string") return;
    let parsed;
    try { parsed = new URL(source); } catch { return; }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    const serverValue = item.serverName ?? item.server?.name ?? item.server ?? item.name ?? label
      ?? embedData.serverName ?? embedData.server?.name ?? embedData.provider ?? data.serverName ?? data.provider;
    const server = typeof serverValue === "string" && serverValue.trim() ? serverValue.trim() : "Ani.pm";
    const referer = item.referer ?? new URL(embedUrl).origin + "/";
    variants.push({
      url: parsed.href,
      server,
      type: item.type ?? item.kind ?? embedData.kind ?? "hls",
      referer,
      embedUrl: item.embedUrl ?? embedUrl,
      audioLang: item.audioLang ?? item.audio ?? embedData.audioLang ?? embedData.audio ?? null,
      subtitles: mapSubtitles(item.subtitles ?? item.tracks ?? embedData.subtitles ?? embedData.tracks, referer),
    });
  };

  for (const item of Array.isArray(embedData.sources) ? embedData.sources : []) add(item);
  if (Array.isArray(embedData.servers)) {
    for (const item of embedData.servers) add(item);
  } else if (embedData.servers && typeof embedData.servers === "object") {
    for (const [name, item] of Object.entries(embedData.servers)) add(item, name);
  }
  add(embedData.source ?? embedData.url ?? embedData.file, embedData.serverName ?? embedData.server);
  if (Array.isArray(data.sources)) for (const item of data.sources) add(item);
  add(data.source ?? data.url ?? data.file, data.serverName ?? data.server);
  return [...new Map(variants.map((item) => [item.url, item])).values()];
}

async function getChannelUrl(series, episode, audio, channel) {
  const url = new URL("/api/anime/settlar/session", SITE);
  url.searchParams.set("selection", series.selection);
  url.searchParams.set("provider", "anipm");
  url.searchParams.set("ep", String(episode));
  url.searchParams.set("channel", channel);
  url.searchParams.set("telemetry", "0");
  const result = await requestJson(url.href);
  const embedUrl = result?.embedUrl ?? result?.url;
  if (!embedUrl) {
    const direct = playbackSources(result, result, SITE + "/");
    if (direct.length) return direct;
  }
  if (!embedUrl) throw new Error(`Ani.pm returned no Settlar embed for ${channel}`);
  const embed = new URL(embedUrl);
  const token = embed.searchParams.get("t");
  if (!token) throw new Error(`Ani.pm Settlar embed is missing its session token for ${channel}`);
  const sessionUrl = new URL("/api/embed/session", EMBED);
  sessionUrl.searchParams.set("t", token);
  const response = await wreq(sessionUrl.href, {
    headers: requestHeaders(embed.href),
    warm: [{ url: `${EMBED}/`, headers: { "User-Agent": UA, Referer: embed.href } }],
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Settlar session HTTP ${response.status}: ${raw.slice(0, 350)}`);
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("Settlar returned invalid session JSON"); }
  const sources = playbackSources(result, data, embed.href);
  if (!sources.length) throw new Error(`Settlar returned no playable source for ${channel}`);
  return sources;
}

async function getBetaServer(anilistId) {
  const key = "np:anipm-beta:v1:" + anilistId;
  const cached = get(key);
  if (isFresh(cached)) return cached.data;
  try {
    const data = await requestJson(SITE + "/api/anime/beta-server/" + encodeURIComponent(anilistId));
    if (data?.available) set(key, data, SHOW_IDENTITY_TTL);
    return data;
  } catch {
    return null;
  }
}

function betaServerRecords(data) {
  if (Array.isArray(data?.servers)) return data.servers;
  if (data?.servers && typeof data.servers === "object") {
    return Object.entries(data.servers).map(([name, server]) => ({ ...server, name: server?.name ?? name }));
  }
  return data ? [data] : [];
}

function betaRenditions(manifest, masterUrl, referer) {
  const audioTracks = [];
  const subtitles = [];
  for (const line of manifest.split(/\r?\n/)) {
    if (!line.startsWith("#EXT-X-MEDIA:")) continue;
    const attributes = {};
    for (const match of line.slice(line.indexOf(":") + 1).matchAll(/([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/g)) {
      attributes[match[1]] = match[2].replace(/^"|"$/g, "");
    }
    let source = null;
    if (attributes.URI) {
      try { source = new URL(attributes.URI, masterUrl).href; } catch {}
    }
    const label = attributes.NAME ?? attributes.LANGUAGE ?? "Track";
    if (attributes.TYPE === "AUDIO") {
      audioTracks.push({
        url: source,
        label,
        language: attributes.LANGUAGE ?? "und",
        default: attributes.DEFAULT === "YES",
        headers: { Referer: referer },
      });
    } else if (attributes.TYPE === "SUBTITLES") {
      subtitles.push({
        url: source,
        label,
        srclang: attributes.LANGUAGE ?? "und",
        default: attributes.DEFAULT === "YES",
        forced: attributes.FORCED === "YES",
        format: "m3u8",
        headers: { Referer: referer },
      });
    }
  }
  return { audioTracks, subtitles };
}

async function betaServerStreams(info, anilistId, episode, audio) {
  const episodeNumber = Number(episode);
  if (!info?.available || !Number.isInteger(episodeNumber) || episodeNumber < 1) return [];
  const streams = [];
  for (const server of betaServerRecords(info)) {
    if (server?.available === false || (server?.[audio] ?? info[audio]) !== true) continue;
    const episodeList = server?.episodes ?? info.episodes;
    if (Array.isArray(episodeList) && !episodeList.some((number) => Number(number) === episodeNumber)) continue;
    let origin;
    let player;
    let master;
    try {
      origin = new URL(server.origin ?? info.origin);
      const route = String(server.path ?? info.path ?? "").replace(/\/+$/, "");
      player = new URL(route + "/" + episodeNumber, origin);
      player.searchParams.set("lang", audio);
      player.searchParams.set("embed", "ani");
      const explicitMaster = server.masterUrl ?? server.hlsUrl ?? server.master;
      if (explicitMaster) {
        master = new URL(String(explicitMaster).replace(/\{(?:episode|ep)\}/gi, String(episodeNumber).padStart(4, "0")), origin);
      } else {
        const routeMatch = new URL(route, origin).pathname.match(/^\/watch\/(.+)-(\d+)\/?$/i);
        if (!routeMatch || Number(routeMatch[2]) !== Number(anilistId)) continue;
        const catalogSlug = routeMatch[1];
        const episodePath = "E" + String(episodeNumber).padStart(4, "0");
        master = new URL("/hls/" + routeMatch[2] + "-" + catalogSlug + "/" + episodePath + "/master.m3u8", origin);
      }
    } catch {
      continue;
    }
    if (!/^https?:$/.test(origin.protocol) || player.origin !== origin.origin || master.origin !== origin.origin) continue;
    const response = await wreq(master.href, {
      headers: {
        ...requestHeaders(player.href),
        Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
      },
    }).catch(() => null);
    if (!response?.ok) continue;
    const manifest = (await response.text()).replace(/^\uFEFF/, "").trimStart();
    if (!manifest.startsWith("#EXTM3U")) continue;
    const tracks = betaRenditions(manifest, master.href, player.href);
    const serverName = String(server.serverName ?? server.label ?? server.name ?? "Beta");
    const subtitleType = tracks.subtitles.length ? "softsub" : "none";
    streams.push({
      url: master.href,
      type: "hls",
      server: serverName,
      referer: player.href,
      embed: player.href,
      subtitleType,
      audioTracks: tracks.audioTracks,
      subtitles: tracks.subtitles,
      priority: 4,
      isActive: false,
    });
    streams.push({
      url: player.href,
      type: "embed",
      server: serverName,
      referer: origin.origin + "/",
      subtitleType,
      audioTracks: tracks.audioTracks,
      subtitles: tracks.subtitles,
      priority: 3,
      isActive: false,
    });
  }
  return streams;
}

async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  const series = await resolveSeries(anilistId, { ...ctx, media });
  const initial = await bootstrap(series, epNum, audio);
  const core = verifyBootstrap(initial, media);
  const episodes = Array.isArray(core.episodes) ? core.episodes : series.episodes;
  const providerEpisode = episodes.find((item) => episodeNumber(item) === Number(epNum));
  const packageInfo = initial.anipmPackages?.episodes?.[String(epNum)] ?? initial.packages?.episodes?.[String(epNum)] ?? series.packages?.[String(epNum)];
  if (!providerEpisode || packageInfo?.[audio] !== true) throw new Error(`Ani.pm ${audio} episode ${epNum} is unavailable`);
  const selection = initial.settlarSelection;
  if (!selection) throw new Error("Ani.pm bootstrap is missing Settlar selection data");
  const currentSeries = { ...series, selection };
  const hardChannel = audio + "hard";
  const hasHard = packageInfo?.[hardChannel] === true;
  const hardFirst = packageInfo?.[hardChannel + "First"] === true;
  const channels = hasHard && hardFirst ? [hardChannel, audio] : [audio, ...(hasHard ? [hardChannel] : [])];
  const streams = [];
  for (const channel of channels) {
    try {
      const resolvedSources = await getChannelUrl(currentSeries, epNum, audio, channel);
      for (const resolved of resolvedSources) {
        streams.push({
          url: resolved.url,
          type: resolved.type,
          server: resolved.server,
          referer: resolved.referer,
          embed: resolved.embedUrl,
          subtitleType: channel.endsWith("hard") ? "hardsub" : "softsub",
          audioLang: resolved.audioLang,
          subtitles: resolved.subtitles,
          priority: channel.endsWith("hard") ? 4 : 5,
          isActive: streams.length === 0,
        });
      }
    } catch (error) {
      if (channel === audio) throw error;
    }
  }
  streams.push(...await betaServerStreams(await getBetaServer(anilistId), anilistId, epNum, audio));
  return json({
    anilistId: Number(anilistId),
    episode: Number(epNum),
    providerEpisode: Number(epNum),
    audio,
    intro: null,
    outro: null,
    streams,
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" } });
    const match = new URL(request.url).pathname.match(/^\/watch\/anipm\/(\d+)\/(sub|dub)\/anipm-(\d+)\/?$/);
    if (!match) return json({ error: "Not found" }, 404);
    try {
      return await handleWatch(match[1], match[2], match[3]);
    } catch (error) {
      return json({ error: error.message, "Raw-ERROR": error.rawBody ?? null, stack: error.stack }, error.status ?? 500);
    }
  },
};
