import { episodeMeta, expectedCount, json } from "../core/new-provider-utils.js";

const BASE = "https://epeng.animeapps.top";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`anibd ${res.status}: ${url}`);
  return res.json();
}

async function fetchHtml(url, referer) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      ...(referer ? { Referer: referer } : {}),
    },
  });
  if (!res.ok) throw new Error(`anibd ${res.status}: ${url}`);
  return res.text();
}

async function fetchServers(anilistId) {
  const data = await fetchJson(`${BASE}/api2.php?epid=${anilistId}`);
  return Array.isArray(data) ? data : [];
}

async function fetchPlayerLinks(providerLink) {
  const data = await fetchJson(`${BASE}/apilink.php?data=${encodeURIComponent(providerLink)}`);
  return Array.isArray(data) ? data : [];
}

function extractVideoUrl(html, origin) {
  const m = html.match(/videoUrl\s*:\s*"([^"]+)"/);
  if (!m) return null;
  const raw = m[1];
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${origin}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

async function resolvePlayerStream(playerLink) {
  const origin = new URL(playerLink).origin;
  const referer = `${origin}/`;
  const html = await fetchHtml(playerLink, referer);
  const hls = extractVideoUrl(html, origin);
  if (!hls) throw new Error(`anibd: no videoUrl found at ${playerLink}`);
  return { hls, referer };
}

function audioFromServerName(name = "") {
  return /dub/i.test(name) ? "dub" : "sub";
}

function buildEpisodeLists(anilistId, groups, ctx, expected) {
  const sub = [];
  const dub = [];
  const seenSub = new Set();
  const seenDub = new Set();
  for (const group of groups) {
    const audio = audioFromServerName(group.server_name);
    for (const ep of group.server_data ?? []) {
      const number = Number(ep.name ?? ep.slug);
      if (!Number.isFinite(number) || number < 1) continue;
      if (expected && number > expected) continue;
      const bucket = audio === "dub" ? dub : sub;
      const seen = audio === "dub" ? seenDub : seenSub;
      if (seen.has(number)) continue;
      seen.add(number);
      const meta = episodeMeta(number, ctx);
      bucket.push({
        id: `watch/anibd/${anilistId}/${audio}/anibd-${number}`,
        number,
        title: meta.title ?? `Episode ${number}`,
        duration: meta.duration,
        filler: meta.filler,
        uncensored: meta.uncensored,
        description: meta.description,
        image: meta.image,
        airDate: meta.airDate,
        sourceLink: ep.link,
        audio,
      });
    }
  }
  sub.sort((a, b) => a.number - b.number);
  dub.sort((a, b) => a.number - b.number);
  return { sub, dub };
}

export async function getEpisodes(anilistId, ctx = {}) {
  const groups = await fetchServers(anilistId);
  if (!groups.length) throw new Error(`anibd: no episodes found for AniList ${anilistId}`);
  const expected = expectedCount(ctx.media, ctx.anizip);
  return {
    meta: {
      id: String(anilistId),
      source: "anibd",
      matchScore: 1,
      numbering: "standard",
      episodeOffset: 0,
    },
    episodes: buildEpisodeLists(anilistId, groups, ctx, expected),
  };
}

async function findEpisodeLink(anilistId, audio, epNum) {
  const groups = await fetchServers(anilistId);
  for (const group of groups) {
    if (audioFromServerName(group.server_name) !== audio) continue;
    for (const ep of group.server_data ?? []) {
      if (Number(ep.name ?? ep.slug) === Number(epNum)) return ep.link;
    }
  }
  return null;
}

async function handleWatch(anilistId, audio, epNum) {
  const providerLink = await findEpisodeLink(anilistId, audio, epNum);
  if (!providerLink) return json({ error: `anibd episode ${epNum} not found` }, 404);

  const servers = await fetchPlayerLinks(providerLink);
  const streams = [];
  let activeAssigned = false;

  for (const entry of servers) {
    if (!entry?.link) continue;
    try {
      const { hls, referer } = await resolvePlayerStream(entry.link);
      streams.push({
        url: hls,
        type: "hls",
        server: entry.server ?? "AniBD",
        referer,
        priority: activeAssigned ? 4 : 5,
        isActive: !activeAssigned,
      });
      activeAssigned = true;
    } catch {
      streams.push({
        url: entry.link,
        type: "embed",
        server: entry.server ?? "AniBD",
        referer: `${new URL(entry.link).origin}/`,
        priority: 1,
        isActive: false,
      });
    }
  }

  return json({ anilistId: Number(anilistId), episode: Number(epNum), audio, streams });
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
    const url = new URL(request.url);
    try {
      const m = url.pathname.match(/^\/watch\/anibd\/(\d+)\/(sub|dub)\/anibd-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
