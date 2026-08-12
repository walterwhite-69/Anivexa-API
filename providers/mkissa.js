import crypto from "node:crypto";

const __name = (fn, _) => fn;

const UA4 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0";
const REFERER = "https://mkissa.to";
const API = "https://api.mkissa.net";
const API_URL = `${API}/api`;
const CDN_ROOT = "https://cdn.mkissa.net/all/mk";
const DISCOVERY_PATH = "/anime/attack-on-titan-Ycid9tDZd2FxGCJ8o/sub/1";
const ANIZIP = "https://api.ani.zip/mappings";
const DEFAULT_BUILD_ID = "99";
const CONTENT_LANE = "k7";
const REFERER_HOST = "mkissa.to";
const KEY_GROUP = "mkissa";
const BOOT_EPOCH_MS = 604800000;
const BOOT_GRACE_MS = 86400000;
const AA_REQ_MS = 300000;
const DEFAULT_MASK_PARTS = ["gs68iqM0RRE=", "3SRW/KDgIiU=", "DXJpkOW4Spo=", "sb7nU0nqIqc="];
const EPISODE_QUERY_HASH = "b0a4efecd8df8fce709468d54aaa716b712c93b5b7e351888ddc242898abc38e";
const DISCOVERY_CONCURRENCY = 16;
const DISCOVERY_LIMIT = 600;
const TMDB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJlYjdkMWM0ZTgwMGUzM2FiMmE3Y2I3NDA5YmM4NjQ2YSIsIm5iZiI6MTc3OTUzMDcxOS40MzIsInN1YiI6IjZhMTE3YmRmYTlhNjNlYmFiOWUzYjc4YyIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.Z9pa96oJEyicf6wAoaKGKJd9ldapeiOdktoJd4xcgLo";

const HEX_TABLE = {
  "79": "A", "7a": "B", "7b": "C", "7c": "D", "7d": "E", "7e": "F", "7f": "G",
  "70": "H", "71": "I", "72": "J", "73": "K", "74": "L", "75": "M", "76": "N", "77": "O",
  "68": "P", "69": "Q", "6a": "R", "6b": "S", "6c": "T", "6d": "U", "6e": "V", "6f": "W",
  "60": "X", "61": "Y", "62": "Z", "59": "a", "5a": "b", "5b": "c", "5c": "d", "5d": "e",
  "5e": "f", "5f": "g", "50": "h", "51": "i", "52": "j", "53": "k", "54": "l", "55": "m",
  "56": "n", "57": "o", "48": "p", "49": "q", "4a": "r", "4b": "s", "4c": "t", "4d": "u",
  "4e": "v", "4f": "w", "40": "x", "41": "y", "42": "z", "08": "0", "09": "1", "0a": "2",
  "0b": "3", "0c": "4", "0d": "5", "0e": "6", "0f": "7", "00": "8", "01": "9", "15": "-",
  "16": ".", "67": "_", "46": "~", "02": ":", "17": "/", "07": "?", "1b": "#", "63": "[",
  "65": "]", "78": "@", "19": "!", "1c": "$", "1e": "&", "10": "(", "11": ")", "12": "*",
  "13": "+", "14": ",", "03": ";", "05": "=", "1d": "%"
};

let cryptoConfigCache = null;
let bootstrapCache = null;

function decodeHexUrl(hex) {
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const pair = hex.substring(i, i + 2).toLowerCase();
    out += HEX_TABLE[pair] ?? pair;
  }
  return out;
}
__name(decodeHexUrl, "decodeHexUrl");

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
__name(sha256Hex, "sha256Hex");

function hmacBytes(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}
__name(hmacBytes, "hmacBytes");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep, "sleep");

function absoluteAssetUrl(value, base = CDN_ROOT) {
  return new URL(value, base.endsWith("/") ? base : `${base}/`).toString();
}
__name(absoluteAssetUrl, "absoluteAssetUrl");

function findBalancedBlock(text, start) {
  let depth = 0;
  let seen = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      depth++;
      seen = true;
    } else if (ch === "}") {
      depth--;
      if (seen && depth === 0) return i + 1;
    }
  }
  return -1;
}
__name(findBalancedBlock, "findBalancedBlock");

function evalCryptoChunk(chunk) {
  const cryptoStart = chunk.search(/const\s+[A-Za-z_$][\w$]*\s*=[^;]{0,160}\?"\d+":"",\s*[A-Za-z_$][\w$]*=\[/);
  if (cryptoStart < 0) return null;
  const tableMatches = [...chunk.slice(0, cryptoStart).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(\)\{const e=\[/g)];
  const tableStart = tableMatches.at(-1)?.index ?? -1;
  const asyncStart = chunk.indexOf("async function", cryptoStart);
  if (tableStart < 0 || asyncStart < 0) return null;
  let code = chunk.slice(tableStart, asyncStart);
  const buildMatch = code.match(/const\s+([A-Za-z_$][\w$]*)\s*=([^;]+?\?"(\d+)":"")\s*,\s*([A-Za-z_$][\w$]*)=\[/);
  if (!buildMatch) return null;
  const buildName = buildMatch[1];
  const maskName = buildMatch[4];
  code = code.replace(new RegExp(`\\b[A-Za-z_$][\\w$]*\\(\\);\\s*const\\s+${buildName}=`), `const ${buildName}=`);
  code = code.replace(new RegExp(`const\\s+${buildName}=`), `var ${buildName}=`);
  code = code.replace(new RegExp(`,\\s*${maskName}=\\[`), `;var ${maskName}=[`);
  code += `\nreturn { buildId: ${buildName}, maskParts: ${maskName} };`;
  const out = Function(code)();
  if (!out?.buildId || !Array.isArray(out.maskParts) || out.maskParts.length < 4) return null;
  return {
    buildId: String(out.buildId),
    maskParts: out.maskParts.slice(0, 4).map(String)
  };
}
__name(evalCryptoChunk, "evalCryptoChunk");

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA4,
      "Referer": `${REFERER}/`,
      ...headers
    }
  });
  if (!res.ok) throw new Error(`Fetch ${res.status}: ${url}`);
  return res.text();
}
__name(fetchText, "fetchText");

async function discoverCryptoConfig(force = false) {
  if (!force && cryptoConfigCache?.expiresAt && Date.now() < cryptoConfigCache.expiresAt) return cryptoConfigCache;
  const fallback = {
    buildId: DEFAULT_BUILD_ID,
    maskParts: DEFAULT_MASK_PARTS,
    expiresAt: Date.now() + 1800000
  };
  if (!force && await isValidCryptoConfig(fallback).catch(() => false)) {
    cryptoConfigCache = fallback;
    return cryptoConfigCache;
  }
  try {
    const html = await fetchText(`${REFERER}${DISCOVERY_PATH}`, { Accept: "text/html,*/*" });
    const appUrl = html.match(/import\("([^"]+\/_app\/immutable\/entry\/app\.[^"]+\.js)"\)/)?.[1] || html.match(/src="([^"]+\/_app\/immutable\/entry\/app\.[^"]+\.js)"/)?.[1];
    if (!appUrl) throw new Error("MKissa app entry not found");
    const app = await fetchText(appUrl, { Accept: "application/javascript,*/*" });
    const queue = [appUrl];
    const seen = new Set();
    while (queue.length && seen.size < DISCOVERY_LIMIT) {
      const batch = queue.splice(0, DISCOVERY_CONCURRENCY).filter((url) => {
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      });
      const chunks = await Promise.all(batch.map(async (url) => {
        try {
          return { url, text: url === appUrl ? app : await fetchText(url, { Accept: "application/javascript,*/*" }) };
        } catch {
          return null;
        }
      }));
      for (const item of chunks.filter(Boolean)) {
        const imported = [
          ...item.text.matchAll(/(?:import\(|from\s*)["']([^"']+\.js)["']/g),
          ...item.text.matchAll(/"(\.\.\/(?:chunks|nodes)\/[^"\n]+\.js)"/g)
        ].map((m) => m[1]).filter((value) => value.startsWith(".") || value.startsWith("/"));
        for (const value of imported) {
          const next = new URL(value, item.url).toString();
          if (!seen.has(next)) queue.push(next);
        }
        if (!/client-crypto|x-aa-boot|aaReq|partB/.test(item.text)) continue;
        const config = evalCryptoChunk(item.text);
        if (config && await isValidCryptoConfig(config).catch(() => false)) {
          cryptoConfigCache = { ...config, expiresAt: Date.now() + 1800000 };
          return cryptoConfigCache;
        }
      }
    }
    throw new Error("MKissa crypto chunk not found");
  } catch {
    cryptoConfigCache = fallback;
    return cryptoConfigCache;
  }
}
__name(discoverCryptoConfig, "discoverCryptoConfig");

function buildMaskSeed(buildId) {
  const n = String(buildId || "");
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    out[i] = (n.charCodeAt(i % n.length) || 0) ^ ((i * 17 + 31) & 255);
  }
  return out;
}
__name(buildMaskSeed, "buildMaskSeed");

function buildMask(buildId, maskParts) {
  const seed = buildMaskSeed(buildId);
  const out = Buffer.alloc(32);
  for (let i = 0; i < maskParts.length; i++) {
    const part = Buffer.from(maskParts[i], "base64");
    const offset = i * 8;
    for (let j = 0; j < 8; j++) {
      out[offset + j] = (part[j] ^ seed[offset + j]) ^ ((i * 41 + j * 7) & 255);
    }
  }
  return out;
}
__name(buildMask, "buildMask");

function currentEpochs(now = Date.now()) {
  const epoch = Math.floor(now / BOOT_EPOCH_MS);
  const previousGrace = now - epoch * BOOT_EPOCH_MS < BOOT_GRACE_MS && epoch > 0 ? epoch - 1 : epoch;
  return [...new Set([previousGrace, epoch])];
}
__name(currentEpochs, "currentEpochs");

function makeBootToken(config, epoch, lane = CONTENT_LANE) {
  const mask = buildMask(config.buildId, config.maskParts);
  const bootKey = hmacBytes(mask, `aa-boot:${config.buildId}`);
  return hmacBytes(bootKey, `${config.buildId}:${KEY_GROUP}:${REFERER_HOST}:${epoch}:${lane}`).toString("hex");
}
__name(makeBootToken, "makeBootToken");

async function isValidCryptoConfig(config, lane = CONTENT_LANE) {
  for (const epoch of currentEpochs()) {
    const res = await fetch(`${API}/client-crypto/v1/bootstrap?buildId=${encodeURIComponent(config.buildId)}&k=${encodeURIComponent(lane)}`, {
      headers: {
        "User-Agent": UA4,
        "Referer": `${REFERER}/`,
        "Origin": REFERER,
        "x-build-id": config.buildId,
        "x-aa-boot": makeBootToken(config, epoch, lane)
      }
    });
    if (res.ok) return true;
  }
  return false;
}
__name(isValidCryptoConfig, "isValidCryptoConfig");

async function fetchBootstrap(lane = CONTENT_LANE, force = false) {
  const config = await discoverCryptoConfig(force);
  if (!force && bootstrapCache?.lane === lane && bootstrapCache.buildId === config.buildId && bootstrapCache.switchAt && Date.now() < bootstrapCache.switchAt) {
    return bootstrapCache;
  }
  let lastError = null;
  for (const epoch of currentEpochs()) {
    const res = await fetch(`${API}/client-crypto/v1/bootstrap?buildId=${encodeURIComponent(config.buildId)}&k=${encodeURIComponent(lane)}`, {
      headers: {
        "User-Agent": UA4,
        "Referer": `${REFERER}/`,
        "Origin": REFERER,
        "x-build-id": config.buildId,
        "x-aa-boot": makeBootToken(config, epoch, lane)
      }
    });
    const raw = await res.text();
    if (!res.ok) {
      lastError = new Error(`Bootstrap ${res.status}: ${raw.slice(0, 180)}`);
      continue;
    }
    const data = JSON.parse(raw);
    if (!data?.partB) {
      lastError = new Error("Bootstrap missing partB");
      continue;
    }
    bootstrapCache = { ...data, lane, buildId: config.buildId, maskParts: config.maskParts };
    return bootstrapCache;
  }
  throw lastError || new Error("MKissa bootstrap failed");
}
__name(fetchBootstrap, "fetchBootstrap");

function deriveLaneKey(partB, config) {
  const encrypted = Buffer.from(partB, "base64");
  const mask = buildMask(config.buildId, config.maskParts);
  const key = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    key[i] = encrypted[i] ^ mask[i % mask.length];
  }
  return key;
}
__name(deriveLaneKey, "deriveLaneKey");

async function getLaneKey(lane = CONTENT_LANE, force = false) {
  const boot = await fetchBootstrap(lane, force);
  return { key: deriveLaneKey(boot.partB, boot), epoch: boot.epoch, buildId: boot.buildId };
}
__name(getLaneKey, "getLaneKey");

function makeAaReq(key, epoch, buildId, queryHash, lane = CONTENT_LANE) {
  const ts = Math.floor(Date.now() / AA_REQ_MS) * AA_REQ_MS;
  const payload = Buffer.from(JSON.stringify({ v: 1, ts, epoch, buildId, qh: queryHash, k: lane }));
  const iv = crypto.createHash("sha256").update(`${epoch}:${buildId}:${queryHash}:${ts}:${lane}`).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from([1]), iv, body]).toString("base64");
}
__name(makeAaReq, "makeAaReq");

function decryptTobeparsed(b64, key) {
  const buf = Buffer.from(b64, "base64");
  const version = buf[0];
  if (version !== 1) throw new Error(`Unsupported MKissa encryption version: ${version}`);
  const iv = buf.subarray(1, 13);
  const body = buf.subarray(13);
  const ct = body.subarray(0, body.length - 16);
  const tag = body.subarray(body.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"));
}
__name(decryptTobeparsed, "decryptTobeparsed");

function episodeQuery() {
  const zt = `
tbObj {
  u
  sm
  md
  ts
}
`;
  const pu = `
_id
name
englishName
nativeName
slugTime
`;
  const xa = `
${pu}
thumbnail
${zt}
lastEpisodeInfo
lastEpisodeDate
type
season
score
airedStart
availableEpisodes
episodeDuration
episodeCount
lastUpdateEnd
characterCount
`;
  const ef = `
  _id
  username
  displayName
  createdAt
  picture
  reputation
  roleLevel

  
  brief
  followerCount
  followingCount
  pDec
  equippedBadgeKey
  equippedBadge {
    key
    name
    rank
    iconPath
    date
  }
  ugcContributorStats {
    mediaEditReviewSubmitCount
    mediaEditApprovedCount
    mediaEditRejectedCount
    mediaEditAppliedCount
    mediaEditContributionPoints
    mediaEditModContributionPoints
  }

  hideMe
`;
  const fr = `
views
likesCount
commentCount
dislikesCount
boostsCount
reviewCount
userScoreCount
userScoreTotalValue
userScoreAverValue
viewers{
firstViewers{
viewCount
lastWatchedDate
user{
${ef}
}
}
recViewers{
viewCount
lastWatchedDate
user{
${ef}
}
}
}
`;
  return `
query(
$showId: String!
$translationType: VaildTranslationTypeEnumType!
$episodeString: String!
) {
episode(
showId: $showId
translationType: $translationType
episodeString: $episodeString
) {
episodeString
uploadDate
sourceUrls
thumbnail
notes
show{
${xa}
description
broadcastInterval
banner
characters
availableEpisodesDetail
nameOnlyString
characters
isAdult
relatedShows
relatedMangas
altNames
disqusIds
}
pageStatus{
_id
notes
pageId
showId
${fr}
}
episodeInfo{
notes
thumbnails
${zt}
vidInforssub
uploadDates
vidInforsdub
vidInforsraw
description
}
versionFix
}
}
`;
}
__name(episodeQuery, "episodeQuery");

async function apiPost(query, variables, options = {}) {
  const config = options.buildId ? options : await discoverCryptoConfig();
  const body = options.extensions ? { query, variables, extensions: options.extensions } : { query, variables };
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA4,
      "Referer": `${REFERER}/`,
      "Origin": REFERER,
      "Content-Type": "application/json",
      "x-build-id": config.buildId
    },
    body: JSON.stringify(body)
  });
  const raw = await res.text();
  if (!res.ok) {
    const err = new Error(`API POST ${res.status}`);
    err.rawBody = raw;
    throw err;
  }
  const json = JSON.parse(raw);
  if (json.errors?.length) {
    const messages = json.errors.map((e) => e.message || e.extensions?.code || "GraphQL error");
    const err = new Error(messages.join(" · "));
    if (messages.includes("NEED_CAPTCHA")) err.code = "NEED_CAPTCHA";
    err.rawBody = raw;
    err.graphql = json;
    throw err;
  }
  return json.data;
}
__name(apiPost, "apiPost");

async function apiEpisode(query, variables, options = {}) {
  const { force = false, captchaRetry = 0, captcha = null } = options;
  const hash = EPISODE_QUERY_HASH || sha256Hex(query);
  const { key, epoch, buildId } = await getLaneKey(CONTENT_LANE, force);
  const extensions = {
    persistedQuery: { version: 1, sha256Hash: hash },
    k: CONTENT_LANE,
    aaReq: makeAaReq(key, epoch, buildId, hash, CONTENT_LANE)
  };
  if (captcha) extensions.captcha = captcha;
  if (captcha) {
    const posted = await apiPost(query, variables, { buildId, extensions });
    return posted?.tobeparsed ? decryptTobeparsed(posted.tobeparsed, key) : posted;
  }
  const url = `${API_URL}?variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA4,
      "Referer": `${REFERER}/`,
      "Origin": REFERER,
      "x-build-id": buildId
    }
  });
  const raw = await res.text();
  if (!res.ok) {
    const err = new Error(`API ${res.status}`);
    err.rawBody = raw;
    throw err;
  }
  const json = JSON.parse(raw);
  const messages = json.errors?.map((e) => e.message || e.extensions?.code).filter(Boolean) || [];
  if (messages.includes("PersistedQueryNotFound") || messages.some((m) => /Context creation failed/i.test(m))) {
    if (hash === EPISODE_QUERY_HASH) {
      const err = new Error(messages.join(" · "));
      err.rawBody = raw;
      throw err;
    }
    const posted = await apiPost(query, variables, { buildId, extensions });
    return posted?.tobeparsed ? decryptTobeparsed(posted.tobeparsed, key) : posted;
  }
  if (messages.includes("NEED_CAPTCHA")) {
    if (captchaRetry < 2) {
      await sleep(3500 + captchaRetry * 3500);
      return apiEpisode(query, variables, { force: true, captchaRetry: captchaRetry + 1 });
    }
    const err = new Error("MKissa requested captcha");
    err.code = "NEED_CAPTCHA";
    err.rawBody = raw;
    throw err;
  }
  if (messages.some((m) => /^AA_CRYPTO_/.test(m))) {
    if (!force) return apiEpisode(query, variables, { force: true, captchaRetry, captcha });
    const err = new Error(messages.join(" · "));
    err.rawBody = raw;
    throw err;
  }
  if (json.data?.tobeparsed) {
    return decryptTobeparsed(json.data.tobeparsed, key);
  }
  if (messages.length) {
    const err = new Error(messages.join(" · "));
    err.rawBody = raw;
    throw err;
  }
  return json.data;
}
__name(apiEpisode, "apiEpisode");

async function searchMkissa(query, mode = "sub") {
  const gql = `query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeEnumType $countryOrigin:VaildCountryOriginEnumType){shows(search:$search limit:$limit page:$page translationType:$translationType countryOrigin:$countryOrigin){edges{_id name englishName nativeName availableEpisodes availableEpisodesDetail aniListId __typename}}}`;
  const data = await apiPost(gql, {
    search: { allowAdult: false, allowUnknown: false, query },
    limit: 40,
    page: 1,
    translationType: mode,
    countryOrigin: "ALL"
  });
  return data?.shows?.edges ?? [];
}
__name(searchMkissa, "searchMkissa");

async function getEpisodeSources(showId, epNum, audio = "sub", captcha = null) {
  const data = await apiEpisode(episodeQuery(), { showId, translationType: audio, episodeString: String(epNum) }, { captcha });
  return data?.episode ?? null;
}
__name(getEpisodeSources, "getEpisodeSources");

async function fetchAniZip(anilistId) {
  const res = await fetch(`${ANIZIP}?anilist_id=${anilistId}`);
  if (!res.ok) return null;
  return res.json();
}
__name(fetchAniZip, "fetchAniZip");

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
__name(normalize, "normalize");

function extractYear(title) {
  if (!title) return null;
  const m = title.match(/\b(19\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1]) : null;
}
__name(extractYear, "extractYear");

function findBestMatch(results, titles, targetYear, targetId) {
  const normalizedTitles = titles.map(normalize).filter(Boolean);
  let bestShow = null;
  let maxScore = -Infinity;
  for (const r of results) {
    if (targetId && r.aniListId && String(r.aniListId) === String(targetId)) return r;
    const names = [r.name, r.englishName, r.nativeName].map(normalize).filter(Boolean);
    let nameScore = 0;
    let isExact = false;
    for (const n of names) {
      if (normalizedTitles.includes(n)) {
        nameScore = 100;
        isExact = true;
        break;
      }
    }
    if (!isExact) {
      let maxFuzzy = 0;
      for (const rName of names) {
        for (const t of normalizedTitles) {
          if (t.includes(rName) || rName.includes(t)) {
            const score = Math.min(rName.length, t.length);
            const lengthPenalty = Math.abs(rName.length - t.length) * 0.1;
            maxFuzzy = Math.max(maxFuzzy, score - lengthPenalty);
          }
        }
      }
      nameScore = maxFuzzy;
    }
    let yearScore = 0;
    const rYear = extractYear(r.name) || extractYear(r.englishName) || extractYear(r.nativeName);
    if (targetYear && rYear) yearScore = rYear === targetYear ? 50 : -200;
    const totalScore = nameScore + yearScore;
    if (totalScore > maxScore) {
      maxScore = totalScore;
      bestShow = r;
    }
  }
  return bestShow || results[0];
}
__name(findBestMatch, "findBestMatch");

async function fetchAniListMedia(anilistId) {
  try {
    const q = "query ($id: Int) { Media (id: $id, type: ANIME) { seasonYear startDate { year } title { romaji english native } } }";
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA4, "Origin": "https://anilist.co" },
      body: JSON.stringify({ query: q, variables: { id: Number(anilistId) } })
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.Media ?? null;
  } catch {
    return null;
  }
}
__name(fetchAniListMedia, "fetchAniListMedia");

async function resolveMkissaId(anilistId, ctx = {}) {
  const [anizipRes, alMedia] = await Promise.all([
    ctx.anizip ? Promise.resolve(ctx.anizip) : fetchAniZip(anilistId).catch(() => ({})),
    ctx.media ? Promise.resolve({ title: ctx.media.title, seasonYear: ctx.media.seasonYear, startDate: ctx.media.startDate }) : fetchAniListMedia(anilistId).catch(() => null)
  ]);
  const anizip = anizipRes || {};
  let titlesToTry = [];
  if (anizip.titles) {
    titlesToTry = [
      anizip.titles.en,
      anizip.titles.ja,
      anizip.titles["x-jat"],
      ...Object.values(anizip.titles)
    ].filter(Boolean);
  }
  if (alMedia?.title) {
    const alTitles = [alMedia.title.english, alMedia.title.romaji, alMedia.title.native].filter(Boolean);
    titlesToTry = [...new Set([...alTitles, ...titlesToTry])];
  }
  if (!titlesToTry.length && anizip.mappings) {
    const apId = anizip.mappings.animeplanet_id;
    if (apId) titlesToTry = [apId.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")];
  }
  if (!titlesToTry.length) throw new Error(`Could not resolve titles for AniList ID: ${anilistId}`);
  const targetYear = alMedia?.seasonYear || alMedia?.startDate?.year || null;
  let allResults = [];
  for (const title of titlesToTry.slice(0, 3)) {
    allResults.push(...await searchMkissa(title, "sub"));
  }
  const seen = new Set();
  allResults = allResults.filter((r) => {
    if (seen.has(r._id)) return false;
    seen.add(r._id);
    return true;
  });
  if (!allResults.length) throw new Error(`No MKissa match for "${titlesToTry[0]}"`);
  const match = findBestMatch(allResults, titlesToTry, targetYear, anilistId);
  return { showId: match._id, show: match, anizip };
}
__name(resolveMkissaId, "resolveMkissaId");

function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
__name(hexToBytes, "hexToBytes");

async function aesDecrypt(hex) {
  const decipher = crypto.createDecipheriv("aes-128-cbc", Buffer.from("kiemtienmua911ca"), Buffer.from("1234567890oiuytr"));
  return Buffer.concat([decipher.update(Buffer.from(hexToBytes(hex))), decipher.final()]).toString("utf8");
}
__name(aesDecrypt, "aesDecrypt");

async function extractMp4(id) {
  try {
    const r = await fetch(`https://www.mp4upload.com/embed-${id}.html`, {
      headers: { "User-Agent": UA4, Referer: "https://mp4upload.com/" }
    });
    if (!r.ok) return null;
    const h = await r.text();
    const m = h.match(/player\.src\s*\(\s*\{[^}]*\bsrc\s*:\s*"([^"]+)"/) || h.match(/"file"\s*:\s*"(https?:[^"]+\.mp4[^"]*)"/) || h.match(/\bsrc\s*:\s*"(https?:[^"]+\.mp4[^"]*)"/);
    return m?.[1]?.replace(/\\/g, "") || null;
  } catch {
    return null;
  }
}
__name(extractMp4, "extractMp4");

async function extractUns(url) {
  try {
    const parsed = new URL(url);
    const id = parsed.hash.replace(/^#/, "").split("&")[0];
    if (!id) return null;
    const base = `${parsed.protocol}//${parsed.host}`;
    const r = await fetch(`${base}/api/v1/video?id=${encodeURIComponent(id)}&w=1280&h=720&r=`, {
      headers: { "User-Agent": UA4, Referer: `${base}/#${id}`, Origin: base }
    });
    if (!r.ok) return null;
    const hex = (await r.text()).trim();
    if (!hex || !/^[0-9a-f]+$/i.test(hex)) return null;
    const data = JSON.parse(await aesDecrypt(hex));
    return data?.source || data?.cf || null;
  } catch {
    return null;
  }
}
__name(extractUns, "extractUns");

async function extractOk(id) {
  try {
    const r = await fetch(`https://ok.ru/videoembed/${id}`, {
      headers: { "User-Agent": UA4, Referer: "https://ok.ru/" }
    });
    if (!r.ok) return null;
    const h = await r.text();
    const m = h.match(/ondemandHls\\&quot;:\\&quot;(https?:\/\/.*?)\\&quot;/);
    return m?.[1]?.replace(/\\u0026/g, "&") || null;
  } catch {
    return null;
  }
}
__name(extractOk, "extractOk");

async function extractStreamSB(id) {
  try {
    const baseHeaders = {
      "User-Agent": UA4,
      "Referer": `${REFERER}/`,
      "watchsb": "streamsb",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9"
    };
    const r1 = await fetch(`https://streamsb.net/api/v1/video?id=${id}`, { headers: baseHeaders });
    const sid = (r1.headers.get("set-cookie") || "").match(/sid=([^;]+)/)?.[1] ?? "";
    const html = await r1.text();
    const m = html.match(/window\.location\.replace\('([^']+)'\)/);
    if (!m) return null;
    const r2 = await fetch(m[1], { headers: { ...baseHeaders, Cookie: `sid=${sid}`, Referer: `https://streamsb.net/e/${id}.html` } });
    if (!r2.ok) return null;
    const ct = r2.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return null;
    const data = await r2.json();
    return data?.stream_data?.file ?? data?.data?.file ?? null;
  } catch {
    return null;
  }
}
__name(extractStreamSB, "extractStreamSB");

async function extractStreamlare(id) {
  try {
    const r = await fetch("https://streamlare.com/api/video/stream/get", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA4, "Referer": "https://streamlare.com/", "Origin": "https://streamlare.com", "Accept": "application/json, */*" },
      body: JSON.stringify({ id })
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.data?.file ?? null;
  } catch {
    return null;
  }
}
__name(extractStreamlare, "extractStreamlare");

async function extractClock(url) {
  try {
    const parsed = new URL(url);
    const clockUrl = parsed.pathname.includes("/clock.json") ? url : url.replace("/clock", "/clock.json");
    const r = await fetch(clockUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        "Referer": "https://allanime.day/player.html",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin"
      }
    });
    if (!r.ok) return null;
    const data = await r.json();
    const links = Array.isArray(data?.links) ? data.links : [];
    const best = links.find((item) => item?.hls && item?.link) || links.find((item) => item?.link);
    return best?.link || null;
  } catch {
    return null;
  }
}
__name(extractClock, "extractClock");

function embedMediaType(url) {
  if (!url) return null;
  if (url.includes(".m3u8")) return "hls";
  if (url.includes(".mp4")) return "mp4";
  return "direct";
}
__name(embedMediaType, "embedMediaType");

async function extractSource(src) {
  let url = src.sourceUrl;
  if (url && url.startsWith("--")) url = decodeHexUrl(url.slice(2));
  if (url && url.startsWith("/apivtwo/clock")) url = "https://allanime.day" + url.replace("/clock", "/clock.json");
  if (url && /^https?:\/\/allanime\.day\/apivtwo\/clock(?:\.json)?/i.test(url)) url = url.replace("/clock?", "/clock.json?");
  let extractedUrl = null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "allanime.day" && /\/apivtwo\/clock(?:\.json)?/i.test(new URL(url).pathname)) {
      extractedUrl = await extractClock(url);
    } else if (src.type === "player") extractedUrl = url;
    else if (host === "mp4upload.com") {
      const m = url.match(/embed-([a-zA-Z0-9]+)\.html/i);
      if (m?.[1]) extractedUrl = await extractMp4(m[1]);
    } else if (/uns\.bio$/i.test(host)) {
      extractedUrl = await extractUns(url);
    } else if (host === "ok.ru") {
      const m = url.match(/\/(?:videoembed\/)?(\d+)(?:[/?#]|$)/i);
      if (m?.[1]) extractedUrl = await extractOk(m[1]);
    } else if (/streamsb\./i.test(host)) {
      const m = url.match(/\/(?:e\/|embed-)([a-zA-Z0-9]+)(?:\.html)?/i);
      if (m?.[1]) extractedUrl = await extractStreamSB(m[1]);
    } else if (/streamlare\./i.test(host)) {
      const m = url.match(/\/e\/([a-zA-Z0-9]+)/i);
      if (m?.[1]) extractedUrl = await extractStreamlare(m[1]);
    }
  } catch {}
  return {
    name: src.sourceName || "",
    url,
    extractedUrl,
    extractedType: embedMediaType(extractedUrl),
    type: src.type,
    priority: src.priority,
    headers: {
      "Referer": REFERER,
      "User-Agent": UA4
    },
    downloads: src.downloads || null
  };
}
__name(extractSource, "extractSource");

async function fetchAniListFull(anilistId) {
  const q = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      idMal
      title { romaji english native }
      synonyms
      format
      episodes
      seasonYear
      startDate { year }
      type
      relations {
        edges { relationType(version: 2) node { id type format title { romaji english native } } }
      }
    }
  }`;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA4, "Origin": "https://anilist.co" },
    body: JSON.stringify({ query: q, variables: { id: Number(anilistId) } })
  });
  if (!res.ok) throw new Error("AniList fetch failed");
  const json = await res.json();
  return json.data?.Media;
}
__name(fetchAniListFull, "fetchAniListFull");

async function fetchKitsuId(malId) {
  if (!malId) return null;
  try {
    const res = await fetch(`https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}`);
    const json = await res.json();
    const mapping = json.data?.[0];
    if (mapping?.relationships?.item?.links?.related) {
      const itemRes = await fetch(mapping.relationships.item.links.related);
      const itemJson = await itemRes.json();
      return itemJson.data?.id ? Number(itemJson.data.id) : null;
    }
  } catch {}
  return null;
}
__name(fetchKitsuId, "fetchKitsuId");

async function fetchTMDB(titles, year, format) {
  const tmdbType = format === "MOVIE" || format === "OVA" || format === "SPECIAL" ? "movie" : "tv";
  let result = null;
  for (const title of titles) {
    if (!title) continue;
    try {
      const searchUrl = `https://api.themoviedb.org/3/search/${tmdbType}?query=${encodeURIComponent(title)}&first_air_date_year=${year}&year=${year}`;
      const res = await fetch(searchUrl, { headers: { Authorization: `Bearer ${TMDB_TOKEN}`, Accept: "application/json" } });
      const json = await res.json();
      if (json.results?.length) {
        result = json.results[0];
        break;
      }
    } catch {}
  }
  if (!result) return { themoviedbId: null, imdbId: null, thetvdbId: null };
  try {
    const extUrl = `https://api.themoviedb.org/3/${tmdbType}/${result.id}/external_ids`;
    const extRes = await fetch(extUrl, { headers: { Authorization: `Bearer ${TMDB_TOKEN}`, Accept: "application/json" } });
    const externalIds = await extRes.json();
    return {
      themoviedbId: result.id,
      imdbId: externalIds.imdb_id || null,
      thetvdbId: externalIds.tvdb_id || null
    };
  } catch {
    return { themoviedbId: result.id, imdbId: null, thetvdbId: null };
  }
}
__name(fetchTMDB, "fetchTMDB");

async function handleMap(anilistId) {
  const al = await fetchAniListFull(anilistId);
  if (!al) throw new Error("AniList entry not found");
  const year = al.seasonYear || al.startDate?.year;
  const titlesToSearch = [al.title.english, al.title.romaji, al.title.native].filter(Boolean);
  const [kitsuId, tmdbData] = await Promise.all([
    fetchKitsuId(al.idMal),
    fetchTMDB(titlesToSearch, year, al.format)
  ]);
  return {
    mappings: {
      id: Number(anilistId),
      title: al.title.english || al.title.romaji,
      type: al.type,
      format: al.format,
      episodes: al.episodes,
      malId: al.idMal,
      aniId: Number(anilistId),
      anidbId: null,
      animePlanetId: null,
      kitsuId,
      imdbId: tmdbData.imdbId,
      themoviedbId: tmdbData.themoviedbId,
      thetvdbId: tmdbData.thetvdbId,
      livechartId: null,
      annId: null,
      synonyms: al.synonyms || [],
      franchise: al.relations?.edges?.map((e) => ({
        relation: e.relationType,
        id: e.node.id,
        title: e.node.title.romaji || e.node.title.english,
        type: e.node.type,
        format: e.node.format
      })) || []
    }
  };
}
__name(handleMap, "handleMap");

async function handleEpisodes(anilistId, ctx = {}) {
  const { showId, show, anizip } = await resolveMkissaId(anilistId, ctx);
  const epDetail = show.availableEpisodesDetail || {};
  const subEps = (epDetail.sub || []).map(Number).sort((a, b) => a - b);
  const dubEps = (epDetail.dub || []).map(Number).sort((a, b) => a - b);
  const buildList = (nums, audio) => nums.map((n) => {
    const meta = anizip.episodes?.[String(n)] ?? {};
    return {
      id: `watch/mkissa/${anilistId}/${audio}/mkissa-${n}`,
      number: n,
      title: meta.title?.en || meta.title?.["x-jat"] || null,
      duration: meta.runtime ?? meta.length ?? 0,
      audio,
      filler: meta.filler ?? false,
      uncensored: false,
      description: meta.overview || meta.summary || null,
      image: meta.image || anizip.images?.cover || null,
      airDate: meta.airdate || meta.aired || null
    };
  });
  return {
    meta: {
      id: showId,
      title: show.englishName || show.name
    },
    episodes: {
      sub: buildList(subEps, "sub"),
      dub: buildList(dubEps, "dub"),
      raw: []
    }
  };
}
__name(handleEpisodes, "handleEpisodes");

async function handleEpisodesRoute(anilistId) {
  const { showId, show, anizip } = await resolveMkissaId(anilistId);
  const epDetail = show.availableEpisodesDetail || {};
  const subEps = (epDetail.sub || []).map(Number).sort((a, b) => a - b);
  const dubEps = (epDetail.dub || []).map(Number).sort((a, b) => a - b);
  const buildEpList = (nums, audio) => nums.map((n) => {
    const meta = anizip.episodes?.[String(n)] ?? {};
    return {
      id: `watch/mkissa/${anilistId}/${audio}/mkissa-${n}`,
      number: n,
      title: meta.title?.en || meta.title?.["x-jat"] || `Episode ${n}`,
      duration: meta.runtime ?? meta.length ?? 0,
      audio,
      filler: meta.filler ?? false,
      uncensored: false,
      description: meta.overview || meta.summary || "",
      image: meta.image || anizip.images?.cover || "",
      airDate: meta.airdate || meta.aired || ""
    };
  });
  return {
    anilistId: Number(anilistId),
    mkissaId: showId,
    title: show.englishName || show.name,
    sub: buildEpList(subEps, "sub"),
    dub: buildEpList(dubEps, "dub")
  };
}
__name(handleEpisodesRoute, "handleEpisodesRoute");

function readCaptcha(request, url) {
  const token = url.searchParams.get("captchaToken") || url.searchParams.get("turnstileToken") || request.headers.get("x-captcha-token") || request.headers.get("cf-turnstile-response");
  const provider = url.searchParams.get("captchaProvider") || request.headers.get("x-captcha-provider") || "turnstile1";
  return token ? { token, provider } : null;
}
__name(readCaptcha, "readCaptcha");

async function handleWatch(anilistId, audio, epNum, captcha = null) {
  const { showId, anizip } = await resolveMkissaId(anilistId);
  const episode = await getEpisodeSources(showId, epNum, audio, captcha);
  if (!episode) throw new Error("Episode not found");
  const sources = await Promise.all((episode.sourceUrls || []).map(extractSource));
  sources.sort((a, b) => b.priority - a.priority);
  const epMeta = anizip?.episodes?.[String(epNum)] ?? {};
  return {
    anilistId: Number(anilistId),
    mkissaId: showId,
    episode: Number(epNum),
    audio,
    intro: epMeta.intro ?? null,
    outro: epMeta.outro ?? null,
    sources
  };
}
__name(handleWatch, "handleWatch");

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300"
    }
  });
}
__name(json, "json");

function matchRoute(pathname) {
  let m = pathname.match(/^\/episodes\/(\d+)\/?$/);
  if (m) return { handler: "episodes", anilistId: m[1] };
  m = pathname.match(/^\/watch\/mkissa\/(\d+)\/(sub|dub)\/mkissa-(\d+)\/?$/);
  if (m) return { handler: "watch", anilistId: m[1], audio: m[2], ep: m[3] };
  m = pathname.match(/^\/map\/(\d+)\/?$/);
  if (m) return { handler: "map", anilistId: m[1] };
  return null;
}
__name(matchRoute, "matchRoute");

const mkissaDefault = {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*"
        }
      });
    }
    const route = matchRoute(url.pathname);
    if (!route) {
      return json({
        error: "Not found",
        routes: [
          "GET /episodes/:anilistId",
          "GET /watch/mkissa/:anilistId/:audio/mkissa-:ep",
          "GET /map/:anilistId"
        ]
      }, 404);
    }
    try {
      if (route.handler === "map") return json(await handleMap(route.anilistId));
      if (route.handler === "episodes") return json(await handleEpisodesRoute(route.anilistId));
      if (route.handler === "watch") return json(await handleWatch(route.anilistId, route.audio, route.ep, readCaptcha(request, url)));
    } catch (err) {
      const status = err.code === "NEED_CAPTCHA" ? 403 : 500;
      return json({ error: err.message, code: err.code ?? null, captcha: err.code === "NEED_CAPTCHA" ? { endpoint: `${API.replace(/\/$/, "")}/captcha/turnstile`, provider: "turnstile1", tokenQuery: "captchaToken", tokenHeader: "x-captcha-token" } : null, "Raw-ERROR": err.rawBody ?? null, stack: err.stack }, status);
    }
  }
};

export default mkissaDefault;
export { handleEpisodes as getEpisodes };
