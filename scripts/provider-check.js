import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { findVideoExtractor } from "../extractors/index.js";

const API_ORIGIN = "https://anivexa.local";
const DEFAULT_ANILIST_ID = "16498";
const MAX_EXTRACTORS_PER_PROVIDER = 2;
const MAX_STREAM_PROBES_PER_PROVIDER = 2;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 12 * 60_000;
const IGNORED_KEYS = /subtitle|caption|thumbnail|storyboard|chapter|download|poster|cover|logo|skip|intro|outro|audio.?track/i;
const URL_KEYS = new Set(["url", "file", "src", "stream_url", "streamurl", "hls", "dash"]);
const EMBED_KEYS = new Set(["embed", "embedurl", "embed_url"]);

function usage() {
  return [
    "Test providers and extractors using the local Anivexa API code.",
    "",
    "Usage:",
    "  npm run test:providers",
    "  npm run test:providers -- --anime-id 16498",
    "  npm run test:providers -- --anime-id 16498 --provider reanime,anihq",
    "",
    "Options:",
    "  --anime-id <id>       AniList ID to look up (default: 16498)",
    "  --provider <names>    Comma-separated API provider names; repeatable",
    "  --help                Show this help",
    "",
    "The live test needs internet access. It checks provider catalogs, watch routes,",
    "registered embed extractors, stream manifests, and returned FlixCloud playlist keys.",
  ].join("\n");
}

function parseArguments(args) {
  let anilistId = DEFAULT_ANILIST_ID;
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
    if (!arg.startsWith("-") && !gotPositionalId) {
      anilistId = arg;
      gotPositionalId = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!/^\d+$/.test(String(anilistId)) || !Number.isSafeInteger(Number(anilistId)) || Number(anilistId) < 1) {
    throw new Error("AniList ID must be a positive integer.");
  }
  return { anilistId: String(anilistId), requestedProviders, help };
}

function safeFailureDetail(message, status) {
  if (status) return `HTTP ${status}`;
  const value = String(message ?? "");
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
  const text = raw.toString("utf8").trim();
  if (candidate.type === "dash") {
    return /<MPD\b/i.test(text)
      ? { ok: true, detail: "DASH manifest is valid" }
      : { ok: false, detail: "response is not an MPD manifest" };
  }

  if (candidate.playlistKey) {
    try {
      const decoded = decodeFlixcloudManifest(raw, candidate.playlistKey);
      return { ok: true, detail: "HLS manifest is valid", keyStatus: decoded.keyStatus };
    } catch (error) {
      return { ok: false, detail: safeFailureDetail(error.message), keyStatus: "playlist key failed" };
    }
  }
  return text.startsWith("#EXTM3U")
    ? { ok: true, detail: "HLS manifest is valid", keyStatus: "not supplied" }
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

async function fetchJson(worker, path, environment) {
  const response = await worker.fetch(
    new Request(new URL(path, API_ORIGIN)),
    environment,
  );
  let payload = null;
  try { payload = await response.json(); } catch {}
  return { response, payload };
}

async function testProvider(providerName, anilistId, catalogResult, worker, environment) {
  const providerData = catalogResult[providerName];
  const episodeCount = countEpisodes(providerData);
  const row = {
    provider: providerName,
    catalog: "",
    episodeCount: episodeCount ?? 0,
    episode: "—",
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
    const { response, payload } = await fetchJson(worker, watchPath, environment);
    watchPayload = payload;
    if (!response.ok) {
      row.watch = "failed";
      row.detail = safeFailureDetail(payload?.error, response.status);
      row.failed = true;
      return row;
    }
  } catch (error) {
    row.watch = "failed";
    row.detail = safeFailureDetail(error.message);
    row.failed = true;
    return row;
  }

  if (!watchPayload || typeof watchPayload !== "object" || Array.isArray(watchPayload) || watchPayload.error) {
    row.watch = "failed";
    row.detail = safeFailureDetail(watchPayload?.error ?? "invalid watch response");
    row.failed = true;
    return row;
  }

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

function printReport(anilistId, rows, suppressedLogs) {
  const pad = (value, width) => String(value).slice(0, width).padEnd(width);
  console.log(`Anivexa local provider/extractor test — AniList ${anilistId}`);
  console.log(`Providers tested: ${rows.length} | Provider log lines suppressed: ${suppressedLogs}`);
  console.log("");
  console.log(`${pad("Provider", 14)} ${pad("Catalog", 18)} ${pad("Episodes", 9)} ${pad("Episode", 13)} ${pad("Watch", 14)} ${pad("Streams", 9)} ${pad("Extractors", 30)} Playlist key`);
  console.log("-".repeat(122));
  for (const row of rows) {
    const extractors = row.extractors.length
      ? row.extractors.map((item) => `${item.name}:${item.ok ? "ok" : "FAIL"}`).join(",")
      : "—";
    console.log(`${pad(row.provider, 14)} ${pad(row.catalog, 18)} ${pad(row.episodeCount, 9)} ${pad(row.episode, 13)} ${pad(row.watch, 14)} ${pad(row.streams, 9)} ${pad(extractors, 30)} ${row.keyStatus}`);
    for (const extractor of row.extractors.filter((item) => !item.ok)) {
      console.log(`  EXTRACTOR FAIL (${extractor.name}): ${extractor.detail}`);
    }
    if (row.detail) console.log(`  ${row.failed ? "FAIL" : row.skipped ? "SKIP" : "INFO"}: ${row.detail}`);
  }

  const passed = rows.filter((row) => row.watch === "passed").length;
  const failed = rows.filter((row) => row.failed).length;
  const skipped = rows.filter((row) => row.skipped).length;
  const partial = rows.filter((row) => row.partial).length;
  console.log("");
  console.log(`Passed: ${passed} | Partial: ${partial} | Failed: ${failed} | No title match: ${skipped}`);
  if (skipped) console.log("A title match is not an uptime failure; choose another AniList ID to exercise more providers.");
  if (failed) console.log("One or more catalog, watch, stream, or extractor checks failed. Review the safe failure details above.");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  process.env.CACHE_ENABLED = "false";
  const { default: worker } = await import("../index.js");
  const environment = { API_VERSION: "2.3" };
  const registryResponse = await worker.fetch(new Request(`${API_ORIGIN}/`), environment);
  const registry = await registryResponse.json();
  if (!registryResponse.ok || !Array.isArray(registry.providers) || registry.providers.length === 0) {
    throw new Error("Could not read the local API provider registry.");
  }

  const selectedProviders = options.requestedProviders.length
    ? [...new Set(options.requestedProviders)]
    : registry.providers;
  const unknown = selectedProviders.filter((name) => !registry.providers.includes(name));
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
    const catalogPath = `/episodes/${selectedProviders.map(encodeURIComponent).join("/")}/${options.anilistId}?map=false`;
    const catalogResponse = await worker.fetch(new Request(new URL(catalogPath, API_ORIGIN)), environment);
    const catalogResult = await catalogResponse.json();
    if (!catalogResponse.ok || catalogResult.error) throw new Error("The local episodes route failed before provider checks could start.");
    if (catalogResult._unknownProviders?.length) throw new Error("The API route rejected a registered provider name.");

    rows = await mapLimit(selectedProviders, 2, (providerName) => testProvider(providerName, options.anilistId, catalogResult, worker, environment));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    clearTimeout(deadline);
  }

  printReport(options.anilistId, rows, suppressedLogs);
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
