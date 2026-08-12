import { json, episodeMeta }                                  from "../core/new-provider-utils.js";
import { getMedia }                                        from "../core/anilist.js";
import { get as cacheGet, set as cacheSet, isFresh,
         SHOW_IDENTITY_TTL }                               from "../core/smartcache.js";

const BASE = "https://senshi.live";
const UA   = "Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0";
const H    = { "User-Agent": UA, "Referer": `${BASE}/` };

async function fetchEpisodeList(malId) {
  const res = await fetch(`${BASE}/episodes/${malId}`, { headers: H });
  if (!res.ok) throw new Error(`Senshi episodes ${res.status} (MAL ${malId})`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchEmbeds(malId, epNum) {
  const res = await fetch(`${BASE}/episode-embeds/${malId}/${epNum}`, { headers: H });
  if (!res.ok) throw new Error(`Senshi embeds ${res.status} (MAL ${malId} ep ${epNum})`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function resolveMalId(anilistId) {
  const cacheKey = `np:senshi:${anilistId}`;
  const cached   = cacheGet(cacheKey);
  if (isFresh(cached)) return cached.data;

  const media = await getMedia(anilistId);
  if (!media?.idMal) throw new Error(`Senshi: no MAL ID found for AniList ${anilistId}`);

  cacheSet(cacheKey, media.idMal, SHOW_IDENTITY_TTL);
  return media.idMal;
}

function isDub(status) {
  return (status ?? "").toLowerCase() === "dub";
}

export async function getEpisodes(anilistId, ctx = {}) {
  const malId = await resolveMalId(anilistId);
  const items = await fetchEpisodeList(malId);

  if (!items.length) {
    throw new Error(`Senshi: no episodes for AniList ${anilistId} (MAL ${malId})`);
  }

  let hasDub = false;
  try {
    const probe = await fetchEmbeds(malId, 1);
    hasDub = probe.some(e => isDub(e.status));
  } catch { /* ignore */ }

  const sub = [];
  const dub = [];

  for (const item of items) {
    const num  = item.ep_id;
    const meta = episodeMeta(num, ctx);
    const title = item.ep_title || meta.title || `Episode ${num}`;
    const duration = meta.duration;
    const filler = item.ep_filler || meta.filler || false;
    const recap = item.ep_recap || false;
    const description = meta.description;
    const image = meta.image;
    const airDate = meta.airDate;

    sub.push({
      id: `watch/senshi/${anilistId}/sub/senshi-${num}`,
      number: num,
      title,
      duration,
      audio: "sub",
      filler,
      recap,
      uncensored: false,
      description,
      image,
      airDate
    });

    if (hasDub) {
      dub.push({
        id: `watch/senshi/${anilistId}/dub/senshi-${num}`,
        number: num,
        title,
        duration,
        audio: "dub",
        filler,
        recap,
        uncensored: false,
        description,
        image,
        airDate
      });
    }
  }

  sub.sort((a, b) => a.number - b.number);
  dub.sort((a, b) => a.number - b.number);

  return {
    meta: {
      title:  ctx.media?.title?.english ?? ctx.media?.title?.romaji ?? null,
      malId,
      source: "senshi",
    },
    episodes: { sub, dub },
  };
}

async function handleWatch(anilistId, audio, epNum) {
  const malId  = await resolveMalId(anilistId);
  const embeds = await fetchEmbeds(malId, epNum);

  if (!embeds.length) {
    return json({ error: `Senshi: no sources for episode ${epNum}` }, 404);
  }

  const wantDub = audio === "dub";
  const source  = embeds.find(e => wantDub ? isDub(e.status) : !isDub(e.status));

  if (!source) {
    return json({ error: `Senshi: no ${audio} source for episode ${epNum}` }, 404);
  }

  const list = await fetchEpisodeList(malId).catch(() => []);
  const epItem = list.find(item => Number(item.ep_id) === Number(epNum));

  const intro = {
    start: epItem?.intro_start ?? 0,
    end: epItem?.intro_end ?? 0,
  };
  const outro = {
    start: epItem?.outro_start ?? 0,
    end: epItem?.outro_end ?? 0,
  };

  const streams   = [];
  const downloads = [];

  if (source.url) {
    streams.push({
      url:      source.url,
      type:     "hls",
      server:   "Senshi",
      referer:  `${BASE}/`,
      priority: 5,
      isActive: true,
    });
  }

  if (source.server2) {
    streams.push({
      url:      source.server2,
      type:     "embed",
      server:   "StreamNin",
      referer:  `${BASE}/`,
      priority: 3,
      isActive: false,
    });
  }

  if (source.serverFM) {
    streams.push({
      url:      source.serverFM,
      type:     "embed",
      server:   "FileMoon",
      referer:  `${BASE}/`,
      priority: 2,
      isActive: false,
    });
  }

  if (source.download) {
    downloads.push({ url: source.download, label: "Download" });
  }

  return json({
    anilistId: Number(anilistId),
    malId,
    episode:   Number(epNum),
    audio,
    intro,
    outro,
    streams,
    downloads,
    headers:   H,
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }
    const url = new URL(request.url);
    try {
      const m = url.pathname.match(/^\/watch\/senshi\/(\d+)\/(sub|dub)\/senshi-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
