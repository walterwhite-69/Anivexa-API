import { getMedia } from "../core/anilist.js";
import { extractBabaStreamDetails } from "../extractors/babastream.js";
import { extractMegaPlayDetails } from "../extractors/megaplay.js";
import { episodeMeta, expectedCount, json } from "../core/new-provider-utils.js";

async function getMalId(anilistId, ctx) {
  const idMal = ctx?.media?.idMal ?? (await getMedia(anilistId)).idMal;
  if (!idMal) throw new Error(`2dhive: no MAL ID found for AniList ${anilistId}`);
  return idMal;
}

const BASE = "https://2dhive.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchPage(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`2dhive ${res.status}: ${url}`);
  return res.text();
}

function extractPlayerProps(html) {
  const idx = html.indexOf("prefetchedHls");
  const propsIdx = idx === -1 ? html.indexOf('component-export="default"') : html.lastIndexOf('props="', idx);
  if (propsIdx === -1) return null;
  const attrIdx = html.indexOf('props="', propsIdx);
  if (attrIdx === -1) return null;
  const valueIdx = attrIdx + 7;
  const endIdx = html.indexOf('"', valueIdx);
  if (endIdx === -1) return null;
  const raw = html.slice(valueIdx, endIdx)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  try { return JSON.parse(raw); } catch { return null; }
}

function extractEpisodePlayerProps(html) {
  const island = html.match(/<astro-island[^>]+component-url="[^"]*EpisodePlayer[^"]*"[^>]+props="([^"]+)"/);
  if (!island) return null;
  const raw = island[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  try { return decodeProps(JSON.parse(raw)); } catch { return null; }
}

function astroDecode(v) {
  if (!Array.isArray(v)) return v;
  const [type, data] = v;
  if (type === 0) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
    return Object.fromEntries(Object.entries(data).map(([k, val]) => [k, astroDecode(val)]));
  }
  if (type === 1) return Array.isArray(data) ? data.map(astroDecode) : data;
  return data;
}

function decodeProps(raw) {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, astroDecode(v)]));
}

function parseEpisodeNums(html, malId) {
  const re = new RegExp(`/episode\\?anime=${malId}&(?:amp;)?ep_num=(\\d+)`, "gi");
  const nums = new Set();
  for (const m of html.matchAll(re)) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

async function fetchEpisodePage(malId, epNum) {
  const html = await fetchPage(`${BASE}/episode?anime=${malId}&ep_num=${epNum}`);
  const rawProps = extractPlayerProps(html);
  const props = rawProps ? decodeProps(rawProps) : {};
  const player = extractEpisodePlayerProps(html) ?? {};
  const iframes = [...html.matchAll(/<iframe[^>]+src="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  const servers = [];
  const add = (name, url, dub = false) => {
    if (!url || servers.some((s) => s.slug === url && Boolean(s.dub) === dub)) return;
    servers.push({ server_name: name, slug: url, dub });
  };
  for (const src of iframes) add(src.includes("babastream") ? "BabaStream" : src.includes("megaplay") ? "MegaPlay" : "Embed", src, src.endsWith("/dub"));
  add("MegaPlay", `https://megaplay.buzz/stream/mal/${malId}/${epNum}/sub`, false);
  add("BabaStream", `https://babastream.top/embed/${malId}/${epNum}/sub`, false);
  add("MegaPlay", `https://megaplay.buzz/stream/mal/${malId}/${epNum}/dub`, true);
  add("BabaStream", `https://babastream.top/embed/${malId}/${epNum}/dub`, true);
  return {
    ...props,
    prefetchedHls: props.prefetchedHls ?? {},
    servers: Array.isArray(props.servers) && props.servers.length ? props.servers : servers,
    totalEpisodes: player.totalEpisodes ?? null
  };
}

export async function getEpisodes(anilistId, ctx = {}) {
  const malId = await getMalId(anilistId, ctx);
  const animeHtml = await fetchPage(`${BASE}/anime?anime=${malId}`);
  const epNums = parseEpisodeNums(animeHtml, malId);
  if (!epNums.length) throw new Error(`2dhive: no episodes found for AniList ${anilistId} (MAL ${malId})`);

  const props = await fetchEpisodePage(malId, epNums[0]);
  const hasDub = Boolean(props.prefetchedHls?.dub?.content) || (Array.isArray(props.servers) && props.servers.some((s) => s.dub));
  const expected = expectedCount(ctx.media, ctx.anizip);

  const sub = [], dub = [];
  for (const num of epNums) {
    if (expected && num > expected) continue;
    const meta = episodeMeta(num, ctx);
    const base = {
      number: num,
      title: meta.title ?? `Episode ${num}`,
      duration: meta.duration ?? null,
      filler: meta.filler ?? false,
      uncensored: meta.uncensored ?? false,
      description: meta.description ?? null,
      image: meta.image ?? null,
      airDate: meta.airDate ?? null,
    };
    sub.push({ id: `watch/2dhive/${anilistId}/sub/2dhive-${num}`, ...base, audio: "sub" });
    if (hasDub) dub.push({ id: `watch/2dhive/${anilistId}/dub/2dhive-${num}`, ...base, audio: "dub" });
  }

  return {
    meta: {
      id: String(anilistId),
      source: "2dhive",
      matchScore: 1,
      numbering: "standard",
      episodeOffset: 0,
    },
    episodes: { sub, dub },
  };
}

async function handleWatch(anilistId, audio, epNum) {
  const malId = await getMalId(anilistId);
  const referer = `${BASE}/episode?anime=${malId}&ep_num=${epNum}`;

  const [propsResult, hiAnimeResult, dlContent] = await Promise.allSettled([
    fetchEpisodePage(malId, epNum),
    audio !== "dub"
      ? fetchHiAnimeHls(malId, epNum, referer)
      : Promise.resolve(null),
    fetchDownloadHls(malId, audio, epNum),
  ]);

  const streams = [];
  const props = propsResult.status === "fulfilled" ? propsResult.value : null;

  if (props) {
    const hlsContent = audio === "dub"
      ? props.prefetchedHls?.dub?.content
      : props.prefetchedHls?.sub?.content;

    if (hlsContent) {
      streams.push({
        server: audio === "dub" ? "HLS DUB" : "HLS SUB",
        url: `/stream/2dhive/${anilistId}/${audio}/${epNum}`,
      });
    }

    const rawServers = Array.isArray(props.servers) ? props.servers : [];
    const selectedServers = rawServers.filter((server) =>
      Boolean(server.dub) === (audio === "dub") && typeof server.slug === "string" && server.slug
    );
    const babaStreams = selectedServers.filter((server) => /babastream\.top\/embed\//i.test(server.slug));
    const megaStreams = selectedServers.filter((server) => /megaplay\.[^/]+\/stream\//i.test(server.slug));

    for (const server of babaStreams) {
      streams.push({
        server: server.server_name || "BabaStream",
        url: server.slug,
        type: "embed",
      });
    }

    const babaResults = await Promise.allSettled(babaStreams.map(async (server) => ({
      embed: server.slug,
      source: await extractBabaStreamDetails(server.slug, { userAgent: UA, referer }),
    })));
    for (const result of babaResults) {
      if (result.status !== "fulfilled" || !result.value.source?.url) continue;
      streams.push({
        server: "BabaStream",
        url: result.value.source.url,
        type: result.value.source.type,
        embed: result.value.embed,
        referer: `${result.value.source.origin}/`,
      });
    }

    const defaultMegaPlay = `https://megaplay.buzz/stream/mal/${malId}/${epNum}/${audio}`;
    const megaPlayEmbeds = [...new Set([
      ...megaStreams.map((server) => server.slug),
      defaultMegaPlay,
    ])];
    const megaPlayResults = await Promise.allSettled(megaPlayEmbeds.map(async (embed) => ({
      embed,
      extracted: await extractMegaPlayDetails(embed, { userAgent: UA, referer }),
    })));
    for (const result of megaPlayResults) {
      if (result.status !== "fulfilled") continue;
      for (const source of result.value.extracted.sources) {
        const stream = {
          server: "MegaPlay",
          url: source.url,
          type: "hls",
          variant: source.variant,
          embed: result.value.embed,
          referer: `${result.value.extracted.origin}/`,
          subtitles: result.value.extracted.tracks,
        };
        if (result.value.extracted.intro) stream.intro = result.value.extracted.intro;
        if (result.value.extracted.outro) stream.outro = result.value.extracted.outro;
        streams.push(stream);
      }
    }

    for (const server of megaStreams) {
      streams.push({
        server: server.server_name || "Embed",
        url: server.slug,
        type: "embed",
      });
    }

    if (!streams.some((stream) => stream.url === defaultMegaPlay)) {
      streams.push({
        server: audio === "dub" ? "MegaPlay Dub" : "MegaPlay Sub",
        url: defaultMegaPlay,
        type: "embed",
      });
    }

    for (const server of selectedServers) {
      if (server.server_name === "HAdfree" || babaStreams.includes(server) || megaStreams.includes(server)) continue;
      streams.push({
        server: server.server_name || "Embed",
        url: server.slug,
        type: "embed",
      });
    }

    const hadfreeEntries = selectedServers.filter((server) => server.server_name === "HAdfree");

    const hadfreeResults = await Promise.allSettled(
      hadfreeEntries.map(entry =>
        fetch(`${BASE}/api/hadfree?slug=${encodeURIComponent(entry.slug)}`, {
          headers: { "User-Agent": UA, "Referer": referer },
        }).then(r => r.ok ? r.json() : null).catch(() => null)
      )
    );

    for (const r of hadfreeResults) {
      if (r.status === "fulfilled" && r.value?.streamUrl) {
        streams.push({ server: "HAdfree", url: r.value.streamUrl });
      }
    }
  }

  const defaultMegaPlay = `https://megaplay.buzz/stream/mal/${malId}/${epNum}/${audio}`;
  if (!streams.some((s) => s.url === defaultMegaPlay)) {
    streams.push({
      server: audio === "dub" ? "MegaPlay Dub" : "MegaPlay Sub",
      url: defaultMegaPlay,
      type: "embed",
    });
  }

  const hiAnime = hiAnimeResult.status === "fulfilled" ? hiAnimeResult.value : null;
  if (hiAnime?.m3u8) {
    const entry = { server: "hiAnime", url: hiAnime.m3u8, type: "hls" };
    if (hiAnime.subtitle) entry.subtitle = hiAnime.subtitle;
    streams.push(entry);
  }

  if (dlContent.status === "fulfilled" && dlContent.value) {
    streams.push({
      server: "Download",
      url: `/stream/2dhive/download/${anilistId}/${audio}/${epNum}`,
    });
  }

  const seen = new Set();
  const cleanStreams = streams.filter((s) => {
    const key = `${s.server}:${s.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return json({ anilistId: Number(anilistId), episode: Number(epNum), audio, streams: cleanStreams });
}

async function fetchDownloadHls(malId, audio, epNum) {
  const fileKey = `${malId}_${epNum}_${audio}`;
  try {
    const res = await fetch(`${BASE}/download?file=${encodeURIComponent(fileKey)}`, {
      headers: {
        "User-Agent": UA,
        "Referer": `${BASE}/episode?anime=${malId}&ep_num=${epNum}`,
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/downloadPayload\s*=\s*(\{.*?\});/s);
    if (!m) return null;
    const payload = JSON.parse(m[1]);
    return payload.hlsContent || null;
  } catch {
    return null;
  }
}

async function fetchHiAnimeHls(malId, epNum, referer) {
  try {
    const res = await fetch(`${BASE}/api/hianime?mal_id=${malId}&ep_num=${epNum}`, {
      headers: { "User-Agent": UA, "Referer": referer },
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  } catch {
    return null;
  }
}

async function handleDownloadStream(anilistId, audio, epNum) {
  const malId = await getMalId(anilistId);
  const content = await fetchDownloadHls(malId, audio, epNum);
  if (!content) {
    return new Response(JSON.stringify({ error: "No download stream found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

async function handleStream(anilistId, audio, epNum) {
  const malId = await getMalId(anilistId);
  const referer = `${BASE}/episode?anime=${malId}&ep_num=${epNum}`;
  const props = await fetchEpisodePage(malId, epNum);
  let content = audio === "dub"
    ? props.prefetchedHls?.dub?.content
    : props.prefetchedHls?.sub?.content;

  if (!content && audio !== "dub") {
    const hiAnime = await fetchHiAnimeHls(malId, epNum, referer);
    if (hiAnime?.m3u8) {
      const res = await fetch(hiAnime.m3u8, { headers: { "User-Agent": UA, "Referer": BASE } }).catch(() => null);
      if (res?.ok) content = await res.text();
      else {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": hiAnime.m3u8,
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          },
        });
      }
    }
  }

  if (!content) {
    return new Response(JSON.stringify({ error: "No HLS stream found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
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
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      let m = path.match(/^\/watch\/2dhive\/(\d+)\/(sub|dub)\/2dhive-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);

      m = path.match(/^\/stream\/2dhive\/(\d+)\/(sub|dub)\/(\d+)\/?$/);
      if (m) return await handleStream(m[1], m[2], m[3]);

      m = path.match(/^\/stream\/2dhive\/download\/(\d+)\/(sub|dub)\/(\d+)\/?$/);
      if (m) return await handleDownloadStream(m[1], m[2], m[3]);

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
