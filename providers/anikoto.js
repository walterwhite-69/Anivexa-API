import { getMedia } from '../core/anilist.js';

const ANIKOTO = "https://anikototv.to";
const MAPPER = "https://mapper.nekostream.site/api/mal";
const ANIZIP = "https://api.ani.zip/mappings";
const SPOOF_REF = "https://hianimes.re/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PROXIES = [
  "http://31.76.102.15:8080",
  "http://84.247.171.137:3128",
  "http://103.48.71.186:83",
  "http://187.250.70.193:3128",
  "http://46.203.233.116:3128",
  "http://94.247.244.120:3128",
  "http://154.59.56.78:999",
  "http://144.31.252.120:8443",
  "http://85.14.247.185:3128",
  "http://150.241.71.85:3128"
];

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 500; // ms
const FETCH_TIMEOUT_MS = 8000;

const LANG_MAP = {
  en: "en", english: "en", ja: "ja", japanese: "ja",
  fr: "fr", french: "fr", de: "de", german: "de",
  es: "es", spanish: "es", pt: "pt", portuguese: "pt"
};

const MODIFIERS = [
  "ova", "movie", "special", "specials", "tales", "journal", "part", "season", "kanwa", "spin-off", "theatre"
];

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function buildProxiedUrl(proxy, target) {
  if (proxy.includes('?url=')) {
    return proxy.replace(/url=.*$/, `url=${encodeURIComponent(target)}`);
  }
  const p = proxy.replace(/\/$/, '');
  return `${p}/${target}`;
}

async function tryFetchWithRetries(url, init = {}, opts = {}) {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const proxies = opts.proxies ?? PROXIES;
  let lastErr = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      console.log(`[Anikoto] [Fetch Direct] Attempt ${attempt + 1}/${maxRetries} -> ${url}`);
      const res = await fetch(url, {
        ...init,
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const raw = await res.text().catch(() => null);
        console.warn(`[Anikoto] [Fetch Direct] HTTP ${res.status} returned for ${url}`);
        const e = new Error(`HTTP ${res.status} fetching ${url}`);
        e.rawBody = raw;
        throw e;
      }
      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      console.warn(`[Anikoto] [Fetch Direct Error] Attempt ${attempt + 1} failed for ${url}: ${err.message}`);

      console.log(`[Anikoto] [Fetch Proxy] Attempting proxy sequence for ${url}...`);
      for (const proxy of proxies) {
        if (!proxy.startsWith('http://') && !proxy.startsWith('https://')) continue;
        
        const proxyController = new AbortController();
        const proxyTimeout = setTimeout(() => proxyController.abort(), FETCH_TIMEOUT_MS);

        try {
          const proxiedUrl = buildProxiedUrl(proxy, url);
          console.log(`[Anikoto] [Fetch Proxy] Trying via proxy: ${proxy} -> ${proxiedUrl}`);

          const clonedInit = {
            ...init,
            signal: proxyController.signal,
            headers: {
              ...(init.headers || {}),
              Host: new URL(url).host,
              'User-Agent': UA
            }
          };

          const pres = await fetch(proxiedUrl, clonedInit);
          clearTimeout(proxyTimeout);

          if (!pres.ok) {
            const raw = await pres.text().catch(() => null);
            console.warn(`[Anikoto] [Fetch Proxy Warning] Proxy HTTP ${pres.status} via ${proxy}`);
            const e = new Error(`Proxy HTTP ${pres.status} via ${proxy} fetching ${url}`);
            e.rawBody = raw;
            throw e;
          }

          console.log(`[Anikoto] [Fetch Proxy Success] Successfully fetched via proxy: ${proxy}`);
          return pres;
        } catch (pErr) {
          clearTimeout(proxyTimeout);
          lastErr = pErr;
          console.warn(`[Anikoto] [Fetch Proxy Error] Proxy ${proxy} failed: ${pErr.message}`);
          await sleep(150);
          continue;
        }
      }

      if (attempt === maxRetries - 1) break;

      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt) + Math.random() * 100;
      console.log(`[Anikoto] [Fetch Retry] All options failed for attempt ${attempt + 1}. Waiting ${Math.round(delay)}ms...`);
      await sleep(delay);
    }
  }

  console.error(`[Anikoto] [Fetch Fatal] All ${maxRetries} direct & proxy attempts failed for ${url}`);
  const err = new Error(`Failed to fetch ${url} after ${maxRetries} attempts`);
  err.cause = lastErr;
  throw err;
}

async function httpGet(url, headers = {}) {
  const res = await tryFetchWithRetries(url, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*", ...headers }
  });
  return res.text();
}

async function getJSON(url, headers = {}) {
  const res = await tryFetchWithRetries(url, {
    headers: { "User-Agent": UA, Accept: "application/json,*/*", ...headers }
  });
  try {
    return await res.json();
  } catch (e) {
    const raw = await res.text().catch(() => null);
    console.error(`[Anikoto] [JSON Error] Failed to parse JSON response from ${url}. Raw snippet:`, raw?.slice(0, 200));
    const _e = new Error(`Invalid JSON from ${url}`);
    _e.rawBody = raw;
    throw _e;
  }
}

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
  console.log(`[Anikoto] [Search] Searching for keyword: "${query}"`);
  const searchHtml = await httpGet(`${ANIKOTO}/filter?keyword=${encodeURIComponent(query)}`, { Referer: `${ANIKOTO}/` });
  const candidates = [];

  const re = /<a\s+[^>]*href="https:\/\/anikototv\.to\/watch\/([^"/]+)(?:\/ep-\d+)?"[^>]*data-jp="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(searchHtml)) !== null) {
    const slug = m[1];
    const jp = m[2].trim();
    const name = m[3].replace(/<[^>]*>/g, "").trim();
    candidates.push({ slug, name, jp });
  }

  if (!candidates.length) {
    console.log(`[Anikoto] [Search] No main candidates matched for "${query}". Trying fallback regex...`);
    const reFallback = /<a\s+[^>]*href="https:\/\/anikototv\.to\/watch\/([^"/]+)(?:\/ep-\d+)?"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = reFallback.exec(searchHtml)) !== null) {
      candidates.push({ slug: m[1], name: m[1], jp: "" });
    }
  }

  const seen = new Set();
  const uniqueCandidates = candidates.filter(c => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });

  console.log(`[Anikoto] [Search] Found ${uniqueCandidates.length} candidate(s) for query "${query}"`);
  return uniqueCandidates;
}

async function findAnikotoShow(media) {
  const primaryEn = media.title?.english;
  const primaryRom = media.title?.romaji;
  const synonyms = media.synonyms || [];

  const keywords = [...new Set([primaryEn, primaryRom, ...synonyms].filter(Boolean))];
  console.log(`[Anikoto] [Show Lookup] Resolving show for title: "${primaryEn || primaryRom}". Search keywords:`, keywords);

  const allCandidatesMap = new Map();

  for (const k of keywords.slice(0, 5)) {
    const res = await searchAnikoto(k).catch(err => {
      console.warn(`[Anikoto] [Show Lookup] Search failed for keyword "${k}": ${err.message}`);
      return [];
    });
    for (const c of res) {
      allCandidatesMap.set(c.slug, c);
    }
  }

  const candidates = Array.from(allCandidatesMap.values());
  if (!candidates.length) {
    console.error(`[Anikoto] [Show Lookup Error] No results found on Anikoto across all keywords for: ${primaryEn || primaryRom}`);
    throw new Error(`No results found on Anikoto for: ${primaryEn || primaryRom}`);
  }

  const scored = candidates.map(c => ({
    ...c,
    score: scoreCandidate(c, primaryEn, primaryRom, synonyms)
  })).sort((a, b) => b.score - a.score);

  const chosen = scored[0];
  console.log(`[Anikoto] [Show Lookup] Selected top candidate: "${chosen.name}" (slug: ${chosen.slug}) with score: ${chosen.score}`);

  const watchHtml = await httpGet(`${ANIKOTO}/watch/${chosen.slug}`, { Referer: `${ANIKOTO}/` });
  const showIdMatch = watchHtml.match(/data-id="(\d+)"/);

  if (!showIdMatch) {
    console.error(`[Anikoto] [Show Lookup Error] Could not extract show ID from page HTML for slug: ${chosen.slug}`);
    throw new Error(`Could not find show ID for slug: ${chosen.slug}`);
  }

  console.log(`[Anikoto] [Show Lookup] Found show ID: ${showIdMatch[1]} for slug: ${chosen.slug}`);
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
  console.log(`[Anikoto] [Embed] Extracting embed source from URL: ${embedUrl}`);
  try {
    const pageHtml = await httpGet(embedUrl, { Referer: SPOOF_REF, "Accept-Language": "en-US,en;q=0.9" });
    const m = pageHtml.match(/data-id="([^"]*)"/);
    if (!m?.[1]) {
      console.warn(`[Anikoto] [Embed Warning] Failed to find data-id in embed page HTML: ${embedUrl}`);
      return null;
    }

    const fileId = m[1];
    const origin = new URL(embedUrl).origin;
    console.log(`[Anikoto] [Embed] Extracted file ID: ${fileId}. Requesting stream sources from origin: ${origin}`);

    const data = await getJSON(`${origin}/stream/getSources?id=${fileId}&id=${fileId}`, {
      Referer: `${origin}/`,
      "X-Requested-With": "XMLHttpRequest"
    });

    console.log(`[Anikoto] [Embed] Stream sources payload retrieved successfully. Sources count: ${data?.sources?.length || 0}`);
    return { fileId, data, origin };
  } catch (e) {
    console.error(`[Anikoto] [Embed Error] Extraction failed for ${embedUrl}: ${e.message}`);
    return null;
  }
}

export async function getEpisodes(anilistId, ctx = {}) {
  console.log(`[Anikoto] [Episodes] Fetching episode list for AniList ID: ${anilistId}`);
  const media = ctx.media || await getMedia(anilistId);
  if (!media) {
    console.error(`[Anikoto] [Episodes Error] Could not resolve media for AniList ID: ${anilistId}`);
    throw new Error(`Could not resolve media for AniList ID: ${anilistId}`);
  }

  const [show, anizipRes] = await Promise.all([
    findAnikotoShow(media),
    ctx.anizip
      ? Promise.resolve(ctx.anizip)
      : getJSON(`${ANIZIP}?anilist_id=${anilistId}`).catch(e => {
          console.warn(`[Anikoto] [Episodes] AniZip lookup failed: ${e.message}`);
          return null;
        })
  ]);

  console.log(`[Anikoto] [Episodes] Fetching HTML episode list for showId: ${show.showId}`);
  const listJson = await getJSON(`${ANIKOTO}/ajax/episode/list/${show.showId}`, {
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${ANIKOTO}/watch/${show.slug}`
  });

  const html = listJson.result || "";
  const sub = [];
  const dub = [];

  let firstMal = media.idMal || anizipRes?.mappings?.mal_id || null;

  if (!firstMal) {
    console.log(`[Anikoto] [Episodes] MAL ID missing. Fallback check via MAPPER: ${MAPPER}/${anilistId}`);
    const mapperRes = await getJSON(`${MAPPER}/${anilistId}`).catch(e => {
      console.warn(`[Anikoto] [Episodes] MAPPER lookup failed: ${e.message}`);
      return null;
    });
    if (mapperRes?.mal_id) {
      firstMal = mapperRes.mal_id;
      console.log(`[Anikoto] [Episodes] Resolved MAL ID via MAPPER: ${firstMal}`);
    }
  }

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
    const num = parseInt(numStr, 10);
    const hasSub = getAttr("sub") === "1";
    const hasDub = getAttr("dub") === "1";
    const malAttr = getAttr("mal");
    if (!firstMal && malAttr) firstMal = parseInt(malAttr, 10);

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

  console.log(`[Anikoto] [Episodes] Successfully parsed ${sub.length} sub and ${dub.length} dub episodes`);

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

export async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  console.log(`[Anikoto] [Watch] Incoming stream request -> AniList ID: ${anilistId}, Ep: ${epNum}, Audio: ${audio}`);

  if (audio !== "sub" && audio !== "dub") {
    console.error(`[Anikoto] [Watch Error] Invalid audio requested: "${audio}". Must be 'sub' or 'dub'.`);
    return jsonResponse({ error: "audio must be sub or dub" }, 400);
  }

  try {
    const media = ctx.media || await getMedia(anilistId);
    if (!media) {
      console.error(`[Anikoto] [Watch Error] Media resolution returned null for AniList ID: ${anilistId}`);
      return jsonResponse({ error: "Media not found" }, 404);
    }

    const show = await findAnikotoShow(media);
    console.log(`[Anikoto] [Watch] Requesting episode list HTML for showId: ${show.showId}`);

    const listJson = await getJSON(`${ANIKOTO}/ajax/episode/list/${show.showId}`, {
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${ANIKOTO}/watch/${show.slug}`
    });

    const html = listJson.result || "";
    let episodeDataId = null;

    const re = /<a\s+[^>]*data-id="([^"]*)"[^>]*>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const tag = m[0];
      const getAttr = (attr) => {
        const x = tag.match(new RegExp(`data-${attr}="([^"]*)"`));
        return x ? x[1] : "";
      };

      if (parseInt(getAttr("num"), 10) === parseInt(epNum, 10)) {
        episodeDataId = getAttr("id");
        break;
      }
    }

    if (!episodeDataId) {
      console.error(`[Anikoto] [Watch Error] Could not find matching episodeDataId for Ep: ${epNum}`);
      return jsonResponse({ error: `Episode ${epNum} not found` }, 404);
    }

    console.log(`[Anikoto] [Watch] Found episodeDataId: ${episodeDataId}. Fetching server options...`);

    const serversJson = await getJSON(`${ANIKOTO}/ajax/episode/servers?episodeId=${episodeDataId}`, {
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${ANIKOTO}/watch/${show.slug}`
    });

    const serversHtml = serversJson.result || "";
    let targetServerId = null;

    const serverRe = /<div\s+[^>]*data-id="([^"]*)"[^>]*data-type="([^"]*)"[^>]*>/g;
    while ((m = serverRe.exec(serversHtml)) !== null) {
      if (m[2] === audio) {
        targetServerId = m[1];
        break;
      }
    }

    if (!targetServerId) {
      console.error(`[Anikoto] [Watch Error] No matching server found for audio type "${audio}" on Ep: ${epNum}`);
      return jsonResponse({ error: `No server found for audio type: ${audio}` }, 404);
    }

    console.log(`[Anikoto] [Watch] Found targetServerId: ${targetServerId} for audio "${audio}". Fetching embed source link...`);

    const sourceLinkJson = await getJSON(`${ANIKOTO}/ajax/episode/sources?id=${targetServerId}`, {
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${ANIKOTO}/watch/${show.slug}`
    });

    const embedUrl = sourceLinkJson.link;
    if (!embedUrl) {
      console.error(`[Anikoto] [Watch Error] Embed source link was empty in response from server ID: ${targetServerId}`);
      return jsonResponse({ error: "Failed to fetch stream embed link" }, 500);
    }

    console.log(`[Anikoto] [Watch] Resolved embed URL: ${embedUrl}`);

    const extracted = await extractEmbedSource(embedUrl);
    if (!extracted || !extracted.data) {
      console.error(`[Anikoto] [Watch Error] Stream extraction failed or returned no data for embed URL: ${embedUrl}`);
      return jsonResponse({ error: "Failed to extract streams from embed" }, 500);
    }

    const streams = (extracted.data.sources || []).map(s => ({
      url: s.file,
      type: s.type || "hls",
      quality: s.label || "auto"
    }));

    const subtitles = (extracted.data.tracks || [])
      .filter(t => t.kind === "captions" || t.kind === "subtitles")
      .map(t => mapTrack(t, "anikoto"));

    console.log(`[Anikoto] [Watch Success] Ready to stream! Extracted ${streams.length} video quality stream(s) and ${subtitles.length} subtitle track(s).`);

    return jsonResponse({
      headers: { Referer: extracted.origin },
      sources: streams,
      subtitles,
      intro: extracted.data.intro || null,
      outro: extracted.data.outro || null
    });
  } catch (err) {
    console.error(`[Anikoto] [Watch Unhandled Error] Exception while processing watch request: ${err.stack || err.message}`);
    return jsonResponse({ error: err.message }, 500);
  }
}
