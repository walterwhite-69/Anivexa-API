import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { findVideoExtractor } from "../extractors/index.js";

const DEFAULT_API_ORIGIN = process.env.ANIVEXA_API_ORIGIN ?? "http://localhost:4000";
const PROVIDER_CASES = JSON.parse(readFileSync(new URL("./provider-cases.json", import.meta.url), "utf8"));
const MAX_EXTRACTORS_PER_PROVIDER = 2;
const MAX_STREAM_PROBES_PER_PROVIDER = 4;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const API_REQUEST_TIMEOUT_MS = 90_000;
const RUN_TIMEOUT_MS = 12 * 60_000;
const IGNORED_KEYS = /subtitle|caption|thumbnail|storyboard|chapter|download|poster|cover|logo|skip|intro|outro|audio.?track/i;
const URL_KEYS = new Set(["url", "file", "src", "stream_url", "streamurl", "hls", "dash"]);
const EMBED_KEYS = new Set(["embed", "embedurl", "embed_url"]);

function usage() {
  return [
    "Test providers and extractors using a running local Anivexa API instance.",
    "",
    "Usage:",
    "  npm run test:providers",
    "  npm run test:providers -- --provider reanime",
    "  npm run test:providers -- --anime-id 16498",
    "  npm run test:providers -- --anime-id 16498 --provider reanime,anihq",
    "  npm run test:providers -- --origin http://localhost:4000",
    "",
    "Options:",
    "  --anime-id <id>       Override the configured sample ID for selected providers",
    "  --provider <names>    Comma-separated API provider names; repeatable",
    "  --origin <url>        Running local API origin (default: http://localhost:4000)",
    "  --help                Show this help",
    "",
    "Start the API locally first. The live test needs internet access and checks provider",
    "catalogs, watch routes, registered extractors, streams, and FlixCloud playlist keys.",
  ].join("\n");
}

function parseArguments(args) {
  let anilistId = null;
  let apiOrigin = DEFAULT_API_ORIGIN;
  let gotPositionalId = false;
  const requestedProviders = [];
  let help = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    const option = arg.startsWith("--") ? arg.split("=", 1)[0] : null;
    const inlineValue = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : null;
    if (option === "--anime-id") {
      anilistId = inlineValue ?? args[++index];
      if (!anilistId) throw new Error("--anime-id requires a value.");
      continue;
    }
    if (option === "--provider") {
      const value = inlineValue ?? args[++index];
      if (!value) throw new Error("--provider requires one or more API names.");
      const names = value.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
      if (!names.length) throw new Error("--provider requires at least one API name.");
      requestedProviders.push(...names);
      continue;
    }
    if (option === "--origin") {
      apiOrigin = inlineValue ?? args[++index];
      if (!apiOrigin) throw new Error("--origin requires a URL.");
      continue;
    }
    if (!arg.startsWith("-") && !gotPositionalId) {
      anilistId = arg;
      gotPositionalId = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (anilistId !== null && (!/^\d+$/.test(String(anilistId)) || !Number.isSafeInteger(Number(anilistId)) || Number(anilistId) < 1)) {
    throw new Error("AniList ID must be a positive integer.");
  }
  let origin;
  try {
    const parsed = new URL(apiOrigin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("invalid origin");
    }
    origin = parsed.origin;
  } catch {
    throw new Error("--origin must be an HTTP(S) origin such as http://localhost:4000.");
  }
  return { anilistId: anilistId === null ? null : String(anilistId), apiOrigin: origin, requestedProviders, help };
}

function safeFailureDetail(message, status) {
  const value = String(message ?? "");
  if (/stream source not found/i.test(value)) return "upstream play page returned no stream source";
  if (/could not confidently match|match not found|no title match/i.test(value)) return "provider could not match this AniList ID";
  if (status) return `HTTP ${status}`;
  const httpStatus = value.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  if (httpStatus) return `HTTP ${httpStatus}`;
  if (/timeout|timed out|abort/i.test(value)) return "request timed out";
  if (/fetch failed|ECONN|ENOTFOUND|network|socket|TLS/i.test(value)) return "network request failed";
  if (/no .*episodes|no .*servers|no .*streams|not found/i.test(value)) return "source or episode was not found";
  return "provider or extractor request failed";
}

function isPrivateAddress(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(value);
  if (family === 4) {
    const [a, b] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 ||
      a === 100 && b >= 64 && b <= 127 ||
      a === 198 && (b === 18 || b === 19);
  }
  if (family === 6) {
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
      /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("::ffff:");
  }
  return true;
}

const dnsCache = new Map();
async function assertPublicHttpUrl(value) {
  const url = new URL(String(value));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("unsupported stream URL");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("local stream hosts are not allowed");
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("private stream hosts are not allowed");
    return url;
  }

  let addresses = dnsCache.get(hostname);
  if (!addresses) {
    addresses = await lookup(hostname, { all: true, verbatim: true });
    dnsCache.set(hostname, addresses);
  }
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error("stream host did not resolve to public addresses");
  }
  return url;
}

async function fetchPublic(urlValue, { headers = {}, method = "GET" } = {}) {
  let url = await assertPublicHttpUrl(urlValue);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await fetch(url, {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirectCount === MAX_REDIRECTS) throw new Error("redirect limit exceeded");
    url = await assertPublicHttpUrl(new URL(location, url).href);
  }
  throw new Error("redirect limit exceeded");
}

async function readBoundedBody(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("stream response exceeded the test size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

function buildStreamHeaders(candidate, range) {
  const supplied = candidate.headers && typeof candidate.headers === "object" ? candidate.headers : {};
  if (Object.keys(supplied).some((name) => /^(authorization|cookie|proxy-authorization)$/i.test(name))) {
    return { skipped: "authorization headers are not forwarded by the test script" };
  }

  const headers = {
    Accept: "*/*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  };
  for (const [name, value] of Object.entries(supplied)) {
    if (/^(referer|origin|user-agent|accept)$/i.test(name) && typeof value === "string") headers[name] = value;
  }
  if (candidate.referer && !headers.Referer && !headers.referer) headers.Referer = candidate.referer;
  if (range) headers.Range = "bytes=0-0";
  return { headers };
}

function inferStreamType(rawType, urlValue) {
  const type = String(rawType ?? "").toLowerCase();
  if (/embed/.test(type)) return "embed";
  if (/hls|mpegurl/.test(type)) return "hls";
  if (/dash|mpd/.test(type)) return "dash";
  if (/mp4|video|file/.test(type)) return "file";
  try {
    const path = new URL(urlValue).pathname.toLowerCase();
    if (path.endsWith(".m3u8")) return "hls";
    if (path.endsWith(".mpd")) return "dash";
    if (/\.(mp4|m4v|webm|mkv)$/.test(path)) return "file";
  } catch {}
  return "unknown";
}

function collectCandidates(value, { allowBareStrings = false } = {}) {
  const candidates = [];
  const seen = new Set();

  function add(url, key, context, forcedEmbed = false) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    const type = inferStreamType(context.type, url);
    const isEmbed = forcedEmbed || type === "embed" || EMBED_KEYS.has(key.toLowerCase());
    const identity = `${url}\n${isEmbed}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    candidates.push({
      url,
      type,
      isEmbed,
      referer: context.referer,
      headers: context.headers,
      playlistKey: context.playlistKey,
      wrappedFormat: context.wrappedFormat,
      wrapperOffsets: context.wrapperOffsets,
      server: context.server,
    });
  }

  function visit(item, inherited = {}, key = "") {
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry, inherited, key);
      return;
    }
    if (typeof item === "string") {
      const normalizedKey = key.toLowerCase();
      if (URL_KEYS.has(normalizedKey) || EMBED_KEYS.has(normalizedKey) || allowBareStrings) {
        add(item, normalizedKey, inherited, EMBED_KEYS.has(normalizedKey));
      }
      return;
    }
    if (!item || typeof item !== "object") return;

    const context = {
      ...inherited,
      type: typeof item.type === "string" ? item.type : inherited.type,
      server: typeof item.server === "string" ? item.server : inherited.server,
      referer: typeof item.referer === "string" ? item.referer : inherited.referer,
      headers: item.headers && typeof item.headers === "object" ? item.headers : inherited.headers,
      playlistKey: typeof item.playlist_key === "string" ? item.playlist_key :
        typeof item.playlistKey === "string" ? item.playlistKey : inherited.playlistKey,
      wrappedFormat: typeof item.wrappedFormat === "string" ? item.wrappedFormat : inherited.wrappedFormat,
      wrapperOffsets: item.wrapperOffsets && typeof item.wrapperOffsets === "object" ? item.wrapperOffsets : inherited.wrapperOffsets,
    };

    for (const [childKey, child] of Object.entries(item)) {
      if (IGNORED_KEYS.test(childKey)) continue;
      visit(child, context, childKey);
    }
  }

  visit(value);
  return candidates;
}

function countEpisodes(providerResult) {
  const episodes = providerResult?.episodes;
  if (!episodes || typeof episodes !== "object") return null;
  return Object.values(episodes).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

function routeEpisodeNumber(episode, provider) {
  const value = Number(episode?.number ?? episode?.sourceNumber);
  if (!Number.isFinite(value)) return null;
  if (!Number.isInteger(value) && !["anihq", "pahenime"].includes(provider)) return null;
  return String(value);
}

function chooseEpisode(providerResult, providerName) {
  for (const audio of ["sub", "dub"]) {
    const episodes = providerResult?.episodes?.[audio];
    if (!Array.isArray(episodes)) continue;
    for (const episode of episodes) {
      const number = routeEpisodeNumber(episode, providerName);
      if (number !== null) return { audio, number };
    }
  }
  return null;
}

function decodeFlixcloudManifest(raw, playlistKey) {
  const text = raw.toString("utf8").trim();
  if (text.startsWith("#EXTM3U")) return { manifest: text, keyStatus: "key present; manifest was plain" };

  const key = Buffer.from(String(playlistKey ?? ""), "base64");
  if (!key.length) throw new Error("FlixCloud playlist key is empty or invalid");
  const payload = Buffer.from(text, "base64");
  if (!payload.length) throw new Error("FlixCloud manifest was neither plaintext nor valid Base64");
  const decoded = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index++) decoded[index] = payload[index] ^ key[index % key.length];
  const manifest = decoded.toString("utf8").trim();
  if (!manifest.startsWith("#EXTM3U")) throw new Error("FlixCloud playlist-key decryption failed");
  return { manifest, keyStatus: "playlist key decrypted the manifest" };
}

async function verifyStream(candidate) {
  const headerResult = buildStreamHeaders(candidate, candidate.type === "file");
  if (headerResult.skipped) return { ok: false, skipped: true, detail: headerResult.skipped };
  if (!["hls", "dash", "file"].includes(candidate.type)) {
    return { ok: false, skipped: true, detail: "stream type is not a testable media URL" };
  }

  const { response } = await fetchPublic(candidate.url, {
    method: "GET",
    headers: headerResult.headers,
  });
  if (!response.ok && !(candidate.type === "file" && response.status === 206)) {
    await response.body?.cancel();
    return { ok: false, detail: `HTTP ${response.status}` };
  }

  if (candidate.type === "file") {
    const reader = response.body?.getReader();
    const first = reader ? await reader.read() : { value: null };
    await reader?.cancel();
    return first.value?.length
      ? { ok: true, detail: `media range returned HTTP ${response.status}` }
      : { ok: false, detail: "media response was empty" };
  }

  const raw = await readBoundedBody(response);
  let manifestBody = raw;
  if (candidate.type === "dash") {
    const text = raw.toString("utf8").trim();
    return /<MPD\b/i.test(text)
      ? { ok: true, detail: "DASH manifest is valid" }
      : { ok: false, detail: "response is not an MPD manifest" };
  }

  if (candidate.wrappedFormat === "image-wrapped-hls") {
    const offset = candidate.wrapperOffsets?.manifest;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= raw.length) {
      return { ok: false, detail: "image-wrapped HLS manifest offset is missing or invalid" };
    }
    manifestBody = raw.subarray(offset);
  }

  if (candidate.playlistKey) {
    try {
      const decoded = decodeFlixcloudManifest(manifestBody, candidate.playlistKey);
      return { ok: true, detail: "HLS manifest is valid", keyStatus: decoded.keyStatus };
    } catch (error) {
      return { ok: false, detail: safeFailureDetail(error.message), keyStatus: "playlist key failed" };
    }
  }
  const text = manifestBody.toString("utf8").trim();
  return text.startsWith("#EXTM3U")
    ? { ok: true, detail: candidate.wrappedFormat === "image-wrapped-hls" ? "image-wrapped HLS manifest is valid at its reported offset" : "HLS manifest is valid", keyStatus: candidate.wrappedFormat === "image-wrapped-hls" ? "image-wrapped offsets returned" : "not supplied" }
    : { ok: false, detail: "response is not an HLS manifest" };
}

async function probeExtractor(candidate) {
  const extractor = findVideoExtractor(candidate.url);
  if (!extractor) return null;

  try {
    await assertPublicHttpUrl(candidate.url);
    const extracted = await extractor.extract(candidate.url, {
      ...(candidate.referer ? { referer: candidate.referer } : {}),
    });
    const streams = collectCandidates(extracted, { allowBareStrings: true }).filter((item) => !item.isEmbed);
    if (!streams.length) {
      return { name: extractor.name, ok: false, detail: "extractor returned no stream URLs", streams: [] };
    }
    return { name: extractor.name, ok: true, detail: `${streams.length} stream URL(s) extracted`, streams };
  } catch (error) {
    return { name: extractor.name, ok: false, detail: safeFailureDetail(error.message), streams: [] };
  }
}

async function fetchJson(apiOrigin, path) {
  const response = await fetch(new URL(path, apiOrigin), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
  });
  let payload = null;
  try { payload = await response.json(); } catch {}
  return { response, payload };
}

function failedProviderRow(providerName, anilistId, detail) {
  return {
    provider: providerName,
    anilistId,
    catalog: "request failed",
    episodeCount: 0,
    episode: "—",
    apiWatch: "skipped",
    watch: "skipped",
    streams: 0,
    extractors: [],
    keyStatus: "—",
    detail,
    failed: true,
    skipped: false,
    partial: false,
  };
}

async function testProvider(providerName, anilistId, catalogResult, apiOrigin) {
  const providerData = catalogResult[providerName];
  const episodeCount = countEpisodes(providerData);
  const row = {
    provider: providerName,
    anilistId,
    catalog: "",
    episodeCount: episodeCount ?? 0,
    episode: "—",
    apiWatch: "skipped",
    watch: "skipped",
    streams: 0,
    extractors: [],
    keyStatus: "—",
    detail: "",
    failed: false,
    skipped: false,
    partial: false,
  };

  if (!providerData) {
    row.catalog = "missing response";
    row.detail = "provider did not appear in the API response";
    row.failed = true;
    return row;
  }
  if (providerData.error) {
    row.catalog = "provider error";
    row.detail = safeFailureDetail(providerData.error);
    row.failed = true;
    return row;
  }
  if (episodeCount === null) {
    row.catalog = "invalid response";
    row.detail = "episodes object is missing";
    row.failed = true;
    return row;
  }
  if (episodeCount === 0) {
    row.catalog = "no title match";
    row.detail = "no episodes for this AniList ID; watch test skipped";
    row.skipped = true;
    return row;
  }

  row.catalog = "episodes found";
  const selected = chooseEpisode(providerData, providerName);
  if (!selected) {
    row.watch = "failed";
    row.detail = "catalog has no episode number supported by the API watch route";
    row.failed = true;
    return row;
  }
  row.episode = `${selected.audio} ${selected.number}`;

  const watchPath = `/watch/${providerName}/${anilistId}/${selected.audio}/${providerName}-${encodeURIComponent(selected.number)}`;
  let watchPayload;
  try {
    const { response, payload } = await fetchJson(apiOrigin, watchPath);
    watchPayload = payload;
    if (!response.ok) {
      row.apiWatch = `HTTP ${response.status}`;
      row.watch = "failed";
      row.detail = safeFailureDetail(payload?.error, response.status);
      row.failed = true;
      return row;
    }
  } catch (error) {
    row.apiWatch = "request failed";
    row.watch = "failed";
    row.detail = safeFailureDetail(error.message);
    row.failed = true;
    return row;
  }

  if (!watchPayload || typeof watchPayload !== "object" || Array.isArray(watchPayload) || watchPayload.error) {
    row.apiWatch = "invalid response";
    row.watch = "failed";
    row.detail = safeFailureDetail(watchPayload?.error ?? "invalid watch response");
    row.failed = true;
    return row;
  }
  if (!Array.isArray(watchPayload.streams) || watchPayload.streams.length === 0) {
    row.apiWatch = "no streams";
    row.watch = "failed";
    row.detail = "watch route returned no stream entries";
    row.failed = true;
    return row;
  }
  row.apiWatch = "HTTP 200";

  const candidates = collectCandidates(watchPayload);
  const embedCandidates = candidates.filter((item) => item.isEmbed);
  const extractorCandidates = embedCandidates
    .filter((item) => findVideoExtractor(item.url))
    .slice(0, MAX_EXTRACTORS_PER_PROVIDER);
  const extractedStreams = [];
  const extractorFailures = [];

  for (const embed of extractorCandidates) {
    const result = await probeExtractor(embed);
    if (!result) continue;
    row.extractors.push({ name: result.name, ok: result.ok, detail: result.detail });
    if (result.ok) extractedStreams.push(...result.streams);
    else extractorFailures.push(result);
  }

  const mediaCandidates = [
    ...candidates.filter((item) => !item.isEmbed),
    ...extractedStreams,
  ].filter((item, index, list) => list.findIndex((other) => other.url === item.url) === index);
  row.streams = mediaCandidates.length + embedCandidates.length;
  if (mediaCandidates.some((item) => item.playlistKey)) row.keyStatus = "playlist key returned";

  let verifiedStream = null;
  let lastStreamFailure = null;
  let authProtectedStream = false;
  const streamCandidates = mediaCandidates
    .filter((item) => ["hls", "dash", "file"].includes(item.type))
    .slice(0, MAX_STREAM_PROBES_PER_PROVIDER);
  for (const stream of streamCandidates) {
    const result = await verifyStream(stream).catch((error) => ({ ok: false, detail: safeFailureDetail(error.message) }));
    if (result.ok) {
      verifiedStream = result;
      if (result.keyStatus && result.keyStatus !== "not supplied") row.keyStatus = result.keyStatus;
      break;
    }
    if (result.skipped && stream.headers && Object.keys(stream.headers).some((name) => /authorization|cookie/i.test(name))) {
      authProtectedStream = true;
      continue;
    }
    lastStreamFailure = result.detail;
    if (result.keyStatus) row.keyStatus = result.keyStatus;
  }

  const hasUnmatchedEmbed = embedCandidates.some((item) => !findVideoExtractor(item.url));
  if (verifiedStream) {
    row.watch = "passed";
    if (row.keyStatus === "—") row.keyStatus = verifiedStream.keyStatus ?? "not required";
  } else if (authProtectedStream && !lastStreamFailure) {
    row.watch = "auth protected";
    row.partial = true;
    row.detail = "provider returned an authenticated stream; authorization was not forwarded by the test script";
  } else if (!streamCandidates.length && extractorCandidates.length && !extractorFailures.length) {
    row.watch = "unverified stream";
    row.partial = true;
    row.detail = "extractor returned a source, but no supported media URL was available to verify";
  } else if (!streamCandidates.length && mediaCandidates.length) {
    row.watch = "unsupported stream";
    row.partial = true;
    row.detail = "watch returned sources, but none used a media type supported by this test";
  } else if (!streamCandidates.length && hasUnmatchedEmbed && !extractorCandidates.length) {
    row.watch = "embed only";
    row.partial = true;
    row.detail = "watch returned an embed without a registered extractor";
  } else {
    row.watch = "failed";
    row.detail = lastStreamFailure ?? (extractorFailures.length ? "one or more extractors failed" : "no playable stream or supported embed was returned");
    row.failed = true;
  }

  if (extractorFailures.length) {
    row.failed = true;
    row.detail = [row.detail, `${extractorFailures.length} extractor check(s) failed`].filter(Boolean).join("; ");
  }
  if (!row.detail && hasUnmatchedEmbed) row.detail = "unregistered embed fallback also returned";
  return row;
}

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function printReport(apiOrigin, rows, suppressedLogs) {
  const pad = (value, width) => String(value).slice(0, width).padEnd(width);
  console.log(`Anivexa local provider/extractor test — API ${apiOrigin}`);
  console.log(`Providers tested: ${rows.length} | Provider log lines suppressed: ${suppressedLogs}`);
  console.log("");
  console.log(`${pad("Provider", 14)} ${pad("AniList ID", 11)} ${pad("Catalog", 18)} ${pad("Episodes", 9)} ${pad("Episode", 13)} ${pad("Watch API", 12)} ${pad("Playback", 16)} ${pad("Streams", 9)} ${pad("Extractors", 30)} Playlist key`);
  console.log("-".repeat(152));
  for (const row of rows) {
    const extractors = row.extractors.length
      ? row.extractors.map((item) => `${item.name}:${item.ok ? "ok" : "FAIL"}`).join(",")
      : "—";
    console.log(`${pad(row.provider, 14)} ${pad(row.anilistId, 11)} ${pad(row.catalog, 18)} ${pad(row.episodeCount, 9)} ${pad(row.episode, 13)} ${pad(row.apiWatch, 12)} ${pad(row.watch, 16)} ${pad(row.streams, 9)} ${pad(extractors, 30)} ${row.keyStatus}`);
    for (const extractor of row.extractors.filter((item) => !item.ok)) {
      console.log(`  EXTRACTOR FAIL (${extractor.name}): ${extractor.detail}`);
    }
    if (row.detail) console.log(`  ${row.failed ? "FAIL" : row.skipped ? "SKIP" : "INFO"}: ${row.detail}`);
  }

  const apiPassed = rows.filter((row) => row.apiWatch === "HTTP 200").length;
  const playbackPassed = rows.filter((row) => row.watch === "passed").length;
  const failed = rows.filter((row) => row.failed).length;
  const skipped = rows.filter((row) => row.skipped).length;
  const partial = rows.filter((row) => row.partial).length;
  console.log("");
  console.log(`Watch API passed: ${apiPassed} | Playback verified: ${playbackPassed} | Partial: ${partial} | Failed: ${failed} | No title match: ${skipped}`);
  if (skipped) console.log("A title match is not an uptime failure; choose another AniList ID to exercise more providers.");
  if (failed) console.log("One or more catalog, watch, stream, or extractor checks failed. Review the safe failure details above.");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const selectedProviders = options.requestedProviders.length
    ? [...new Set(options.requestedProviders)]
    : Object.keys(PROVIDER_CASES);
  const unknown = selectedProviders.filter((name) => !Object.hasOwn(PROVIDER_CASES, name));
  if (unknown.length) throw new Error(`Unknown provider API name(s): ${unknown.join(", ")}.`);

  const originalLog = console.log;
  const originalError = console.error;
  let suppressedLogs = 0;
  const deadline = setTimeout(() => {
    originalError(`Provider test exceeded ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes and was stopped.`);
    process.exit(2);
  }, RUN_TIMEOUT_MS);

  console.log = () => { suppressedLogs++; };
  console.error = () => { suppressedLogs++; };

  let rows;
  try {
    rows = await mapLimit(selectedProviders, 2, async (providerName) => {
      const configuredCase = PROVIDER_CASES[providerName];
      const configuredId = String(configuredCase?.anilistId ?? "");
      const anilistId = options.anilistId ?? configuredId;
      if (!/^\d+$/.test(anilistId) || Number(anilistId) < 1) {
        return failedProviderRow(providerName, anilistId || "—", "provider case has no valid AniList ID");
      }
      const catalogPath = `/episodes/${encodeURIComponent(providerName)}/${anilistId}?map=false`;
      try {
        const { response, payload } = await fetchJson(options.apiOrigin, catalogPath);
        if (!response.ok) return failedProviderRow(providerName, anilistId, `catalog HTTP ${response.status}`);
        return testProvider(providerName, anilistId, payload, options.apiOrigin);
      } catch (error) {
        return failedProviderRow(providerName, anilistId, safeFailureDetail(error.message));
      }
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    clearTimeout(deadline);
  }

  printReport(options.apiOrigin, rows, suppressedLogs);
  if (!rows.some((row) => row.catalog === "episodes found")) {
    console.error("No selected provider returned episodes. Try a different AniList ID.");
    process.exitCode = 1;
  } else if (rows.some((row) => row.failed)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Provider test could not complete: ${safeFailureDetail(error.message)}`);
  process.exitCode = 1;
});
