import { getMedia } from '../core/anilist.js';

const ANIKOTO = "https://anikototv.to";
const MAPPER = "https://mapper.nekostream.site/api/mal";
const ANIZIP = "https://api.ani.zip/mappings";
const SPOOF_REF = "https://hianimes.re/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LANG_MAP = {
  en: "en", english: "en", ja: "ja", japanese: "ja",
  fr: "fr", french: "fr", de: "de", german: "de",
  es: "es", spanish: "es", pt: "pt", portuguese: "pt"
};

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function httpGet(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*", ...headers } });
  if (!res.ok) {
    const _raw = await res.text().catch(() => null);
    const _e = new Error(`HTTP ${res.status} fetching ${url}`);
    _e.rawBody = _raw;
    throw _e;
  }
  return res.text();
}

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,*/*", ...headers } });
  if (!res.ok) {
    const _raw = await res.text().catch(() => null);
    const _e = new Error(`HTTP ${res.status} fetching ${url}`);
    _e.rawBody = _raw;
    throw _e;
  }
  return res.json();
}

const MODIFIERS = [
  "ova", "movie", "special", "specials", "tales", "journal", "part", "season", "kanwa", "spin-off", "theatre"
];

function scoreCandidate(cand, primaryEn, primaryRom, synonyms) {
  let score = 0;
  const candNameNorm = normalize(cand.name);
  const candJpNorm   = normalize(cand.jp);
  const candSlugNorm = normalize(cand.slug);

  const normEn  = normalize(primaryEn);
  const normRom = normalize(primaryRom);

  if (normEn && candNameNorm === normEn) score += 1000;
  if (normRom && candNameNorm === normRom) score += 900;
  if (normRom && candJpNorm === normRom) score += 800;

  const targetText = `${primaryEn || ""} ${primaryRom || ""} ${(synonyms || []).join(" ")}`.toLowerCase();
  
  for (const mod of MODIFIERS) {
    const candHasMod = candNameNorm.includes(mod) || candSlugNorm.includes(mod);
    const targetHasMod = targetText.includes(mod);
    if (candHasMod && !targetHasMod) {
      score -= 300;
    }
  }

  for (const t of [primaryEn, primaryRom, ...(synonyms || [])]) {
    const normT = normalize(t);
    if (!normT || normT.length < 3) continue;

    if (candNameNorm === normT) score += 200;
    else if (candNameNorm.startsWith(normT) || normT.startsWith(candNameNorm)) score += 80;
    else if (candNameNorm.includes(normT) || normT.includes(candNameNorm)) score += 40;

    if (candJpNorm && candJpNorm === normT) score += 100;
  }

  const lengthDiff = Math.abs(candNameNorm.length - (normEn || normRom || "").length);
  score -= lengthDiff * 2;

  return score;
}

async function searchAnikoto(query) {
  const searchHtml = await httpGet(`${ANIKOTO}/filter?keyword=${encodeURIComponent(query)}`, { Referer: `${ANIKOTO}/` });
  const candidates = [];
  
  const re = /<a\s+class="name d-title"\s+href="https:\/\/anikototv\.to\/watch\/([^"/]+)(?:\/ep-\d+)?"[^>]*data-jp="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(searchHtml)) !== null) {
    const slug = m[1];
    const jp = m[2].trim();
    const name = m[3].replace(/<[^>]*>/g, "").trim();
    candidates.push({ slug, name, jp });
  }

  if (!candidates.length) {
    const reFallback = /<a\s+href="https:\/\/anikototv\.to\/watch\/([^"/]+)(?:\/ep-\d+)?"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = reFallback.exec(searchHtml)) !== null) {
      candidates.push({ slug: m[1], name: m[1], jp: "" });
    }
  }

  const seen = new Set();
  return candidates.filter(c => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });
}

async function findAnikotoShow(media) {
  const primaryEn = media.title?.english;
  const primaryRom = media.title?.romaji;
  const synonyms = media.synonyms || [];

  const keywords = [...new Set([primaryEn, primaryRom, ...synonyms].filter(Boolean))];
  const allCandidatesMap = new Map();

  for (const k of keywords.slice(0, 5)) {
    const res = await searchAnikoto(k).catch(() => []);
    for (const c of res) {
      allCandidatesMap.set(c.slug, c);
    }
  }

  const candidates = Array.from(allCandidatesMap.values());
  if (!candidates.length) {
    throw new Error(`No results found on Anikoto for: ${primaryEn || primaryRom}`);
  }

  const scored = candidates.map(c => ({
    ...c,
    score: scoreCandidate(c, primaryEn, primaryRom, synonyms)
  })).sort((a, b) => b.score - a.score);

  const chosen = scored[0];
  const watchHtml = await httpGet(`${ANIKOTO}/watch/${chosen.slug}`, { Referer: `${ANIKOTO}/` });
  const showIdMatch = watchHtml.match(/data-id="(\d+)"/);
  if (!showIdMatch) throw new Error(`Could not find show ID for slug: ${chosen.slug}`);

  return { slug: chosen.slug, showId: showIdMatch[1], title: chosen.name };
}

function mapTrack(t, source) {
  const label = t.label ?? "";
  const langKey = label.toLowerCase().split(" ")[0];
  return {
    url: t.file,
    label: label || "English",
    srclang: LANG_MAP[langKey] ?? "en",
    default: t.default ?? false,
    source
  };
}

async function extractEmbedSource(embedUrl) {
  try {
    const pageHtml = await httpGet(embedUrl, { Referer: SPOOF_REF, "Accept-Language": "en-US,en;q=0.9" });
    const m = pageHtml.match(/data-id="([^"]*)"/);
    if (!m?.[1]) return null;
    const fileId = m[1];
    const origin = new URL(embedUrl).origin;
    const data = await getJSON(`${origin}/stream/getSources?id=${fileId}&id=${fileId}`, { Referer: `${origin}/`, "X-Requested-With": "XMLHttpRequest" });
    return { fileId, data, origin };
  } catch (e) {
    return null;
  }
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media || await getMedia(anilistId);
  if (!media) throw new Error(`Could not resolve media for AniList ID: ${anilistId}`);

  const [show, anizipRes] = await Promise.all([
    findAnikotoShow(media),
    ctx.anizip
      ? Promise.resolve(ctx.anizip)
      : getJSON(`${ANIZIP}?anilist_id=${anilistId}`).catch(() => null)
  ]);

  const listJson = await getJSON(`${ANIKOTO}/ajax/episode/list/${show.showId}`, {
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${ANIKOTO}/watch/${show.slug}`
  });

  const html = listJson.result || "";
  const sub = [];
  const dub = [];

  let firstMal = media.idMal || null;

  const re = /<a\s+[^>]*data-id="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const inner = m[2];
    const getAttr = (attr) => {
      const x = tag.match(new RegExp(`data-${attr}="([^"]*)"`));
      return x ? x[1] : "";
    };

    const numStr = getAttr("num");
    if (!numStr) continue;
    const num = parseInt(numStr);
    const hasSub = getAttr("sub") === "1";
    const hasDub = getAttr("dub") === "1";
    const malAttr = getAttr("mal");
    if (!firstMal && malAttr) firstMal = parseInt(malAttr);

    const titleMatch = inner.match(/<span class="d-title"[^>]*>([\s\S]*?)<\/span>/);
    const parsedTitle = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, "").trim() : "";
    const epTitle = parsedTitle || `Episode ${num}`;

    const azEp = anizipRes?.episodes?.[String(num)] ?? {};
    const img = azEp.image || null;
    const desc = azEp.overview || azEp.summary || null;
    const airDate = azEp.airDate || azEp.airdate || null;

    const base = {
      number: num,
      title: epTitle,
      duration: null,
      filler: false,
      uncensored: false,
      description: desc,
      image: img,
      airDate: airDate
    };

    if (hasSub) {
      sub.push({
        id: `watch/anikoto/${anilistId}/sub/anikoto-${num}`,
        ...base,
        audio: "sub"
      });
    }
    if (hasDub) {
      dub.push({
        id: `watch/anikoto/${anilistId}/dub/anikoto-${num}`,
        ...base,
        audio: "dub"
      });
    }
  }

  sub.sort((a, b) => a.number - b.number);
  dub.sort((a, b) => a.number - b.number);

  return {
    meta: {
      title: show.title,
      slug: show.slug,
      malId: firstMal,
      source: "anikoto"
    },
    episodes: { sub, dub }
  };
}

async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  if (audio !== "sub" && audio !== "dub") {
    return jsonResponse({ error: "audio must be sub or dub" }, 400);
  }

  const media = ctx.media || await getMedia(anilistId);
  if (!media) {
    return jsonResponse({ error: `Could not resolve media for AniList ID: ${anilistId}` }, 400);
  }

  const show = await findAnikotoShow(media);
  const listJson = await getJSON(`${ANIKOTO}/ajax/episode/list/${show.showId}`, {
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${ANIKOTO}/watch/${show.slug}`
  });

  const html = listJson.result || "";
  let targetEp = null;
  const re = /<a\s+[^>]*data-id="([^"]*)"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const getAttr = (attr) => {
      const x = tag.match(new RegExp(`data-${attr}="([^"]*)"`));
      return x ? x[1] : "";
    };
    if (parseInt(getAttr("num")) === epNum) {
      targetEp = {
        ids: getAttr("ids"),
        mal: getAttr("mal"),
        slug: getAttr("slug"),
        timestamp: getAttr("timestamp")
      };
      break;
    }
  }

  if (!targetEp?.ids) {
    return jsonResponse({ error: `Episode ${epNum} not found for show: ${show.title}` }, 404);
  }

  const malIdNum = media.idMal || (targetEp.mal ? parseInt(targetEp.mal) : null);

  const [serverDataRes, mapperRes] = await Promise.allSettled([
    getJSON(`${ANIKOTO}/ajax/server/list?servers=${encodeURIComponent(targetEp.ids)}`, {
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${ANIKOTO}/`
    }),
    (targetEp.mal && targetEp.slug && targetEp.timestamp)
      ? getJSON(`${MAPPER}/${targetEp.mal}/${targetEp.slug}/${targetEp.timestamp}`, { Referer: `${ANIKOTO}/` })
      : Promise.resolve(null)
  ]);

  const serverData = serverDataRes.status === "fulfilled" ? serverDataRes.value : null;
  const mapperData = mapperRes.status === "fulfilled" ? mapperRes.value : null;

  const serverHtml = serverData?.result || "";
  const serverItems = [];
  const downloadItems = [];

  const typeRe = /<div class="type" data-type="([^"]+)">([\s\S]*?)<\/ul>\s*<\/div>/g;
  let typeM;
  while ((typeM = typeRe.exec(serverHtml)) !== null) {
    const typeName = typeM[1];
    for (const li of typeM[2].matchAll(/<li\s+([^>]*data-link-id[^>]*)>([\s\S]*?)<\/li>/g)) {
      const linkId = li[1].match(/data-link-id="([^"]+)"/)?.[1];
      const name = li[2].replace(/<[^>]+>/g, "").trim();
      if (!linkId) continue;

      if (typeName === "dl" || name.toLowerCase().includes("download") || name.toLowerCase().includes("kiwi")) {
        downloadItems.push({ linkId, name });
      } else if (typeName === audio) {
        serverItems.push({ linkId, name });
      }
    }
  }

  if (mapperData) {
    for (const [sKey, sObj] of Object.entries(mapperData)) {
      if (sKey === "status") continue;
      const cleanName = sKey.replace(/[-_]+$/, "").trim();
      if (sObj?.[audio]?.url) {
        serverItems.push({ linkId: sObj[audio].url, name: cleanName });
      }
      if (sObj?.[audio]?.download) {
        for (const [dLabel, dUrl] of Object.entries(sObj[audio].download)) {
          if (dUrl && typeof dUrl === "string") {
            downloadItems.push({ url: dUrl, name: cleanName });
          }
        }
      }
    }
  }

  const streams = [];
  const subtitles = [];
  const downloads = [];

  const serverSeen = new Set();
  const subSeen = new Set();
  const dlSeen = new Set();

  for (const item of serverItems) {
    if (serverSeen.has(item.name)) continue;
    serverSeen.add(item.name);

    const resolved = item.linkId.startsWith("http")
      ? { result: { url: item.linkId } }
      : await getJSON(`${ANIKOTO}/ajax/server?get=${encodeURIComponent(item.linkId)}`, {
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${ANIKOTO}/`
        }).catch(() => null);

    const embedUrl = resolved?.result?.url;
    if (!embedUrl) continue;

    let serverIntro = { start: 0, end: 0 };
    let serverOutro = { start: 0, end: 0 };

    if (resolved?.result?.skip_data?.intro?.length === 2) {
      const [s, e] = resolved.result.skip_data.intro;
      if (s || e) serverIntro = { start: Number(s) || 0, end: Number(e) || 0 };
    }
    if (resolved?.result?.skip_data?.outro?.length === 2) {
      const [s, e] = resolved.result.skip_data.outro;
      if (s || e) serverOutro = { start: Number(s) || 0, end: Number(e) || 0 };
    }

    let hlsUrl = null;

    if (embedUrl.includes("#aHR0c")) {
      const b64 = embedUrl.split("#")[1];
      try {
        const decodedUrl = atob(b64);
        if (decodedUrl.includes(".m3u8")) {
          hlsUrl = decodedUrl;
        }
      } catch (e) {}
    }

    const extracted = await extractEmbedSource(embedUrl);
    const itemSubs = [];

    if (extracted?.data?.sources?.file) {
      hlsUrl = extracted.data.sources.file;

      for (const t of extracted.data.tracks ?? []) {
        const mapped = mapTrack(t, item.name);
        itemSubs.push(mapped);
        if (!subSeen.has(mapped.url)) {
          subSeen.add(mapped.url);
          subtitles.push(mapped);
        }
      }

      if (extracted.data.intro?.start || extracted.data.intro?.end) {
        serverIntro = { start: Number(extracted.data.intro.start) || 0, end: Number(extracted.data.intro.end) || 0 };
      }
      if (extracted.data.outro?.start || extracted.data.outro?.end) {
        serverOutro = { start: Number(extracted.data.outro.start) || 0, end: Number(extracted.data.outro.end) || 0 };
      }
    }

    if (hlsUrl) {
      const streamObj = {
        url: hlsUrl,
        type: "hls",
        server: item.name,
        embedUrl,
        referer: extracted?.origin ? `${extracted.origin}/` : `${new URL(embedUrl).origin}/`,
        subtitles: itemSubs,
        priority: 5,
        isActive: streams.length === 0
      };
      if (serverIntro.start || serverIntro.end) streamObj.intro = serverIntro;
      if (serverOutro.start || serverOutro.end) streamObj.outro = serverOutro;
      streams.push(streamObj);
    } else {
      const streamObj = {
        url: embedUrl,
        type: "embed",
        server: item.name,
        referer: `${new URL(embedUrl).origin}/`,
        priority: 4,
        isActive: streams.length === 0
      };
      if (serverIntro.start || serverIntro.end) streamObj.intro = serverIntro;
      if (serverOutro.start || serverOutro.end) streamObj.outro = serverOutro;
      streams.push(streamObj);
    }
  }

  for (const dl of downloadItems) {
    let dlUrl = dl.url;
    if (!dlUrl && dl.linkId) {
      const resolved = await getJSON(`${ANIKOTO}/ajax/server?get=${encodeURIComponent(dl.linkId)}`, {
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${ANIKOTO}/`
      }).catch(() => null);
      dlUrl = resolved?.result?.url;
    }

    if (dlUrl && !dlSeen.has(dlUrl)) {
      dlSeen.add(dlUrl);
      downloads.push({
        url: dlUrl,
        label: dl.name
      });
    }
  }

  return jsonResponse({
    anilistId: parseInt(anilistId),
    malId: malIdNum,
    episode: epNum,
    audio,
    streams,
    subtitles,
    downloads,
    headers: {
      "User-Agent": UA,
      "Referer": streams[0]?.referer || "https://anikototv.to/"
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*"
        }
      });
    }
    try {
      let m = path.match(/^\/watch\/anikoto\/(\d+)\/(sub|dub)\/anikoto-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], parseInt(m[3]));

      m = path.match(/^\/episodes\/anikoto\/(\d+)\/?$/);
      if (m) {
        const data = await getEpisodes(parseInt(m[1]));
        return jsonResponse(data);
      }
      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message, stack: err.stack }, 500);
    }
  }
};
