import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export function canExtractVoe(url) {
  return /(?:^|\/\/)(?:www\.)?voe\.sx\/e\/[A-Za-z0-9_-]+(?:[/?#]|$)/i.test(String(url));
}

async function get(url, { fetchImpl = fetch, userAgent = DEFAULT_USER_AGENT, referer } = {}) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/json,*/*",
      ...(referer ? { Referer: referer } : {}),
    },
  });
  if (!response.ok) throw new Error(`VOE HTTP ${response.status}: ${url}`);
  return response;
}

export function decodePayload(raw) {
  const rot13 = raw.replace(/[a-zA-Z]/g, (character) => {
    const base = character <= "Z" ? 65 : 97;
    return String.fromCharCode(((character.charCodeAt(0) - base + 13) % 26) + base);
  });
  let step = rot13;
  for (const token of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) step = step.split(token).join("_");
  step = step.split("_").join("");
  step = Buffer.from(step, "base64").toString("binary");
  step = step.split("").map((character) => String.fromCharCode(character.charCodeAt(0) - 3)).join("");
  step = step.split("").reverse().join("");
  return JSON.parse(Buffer.from(step, "base64").toString("binary"));
}

async function resolvePage(embedUrl, options = {}) {
  let current = new URL(String(embedUrl)).href;
  const referer = options.referer ?? `${new URL(current).origin}/`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await get(current, { ...options, referer });
    const body = await response.text();
    const finalUrl = response.url || current;
    const redirect = body.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (redirect) {
      current = new URL(redirect[1], finalUrl).href;
      continue;
    }
    if (/Redirecting/i.test(body) && /permanentToken/.test(body)) {
      const next = body.match(/https?:\/\/[^'"]+\/e\/[^'"]+/);
      if (next) {
        current = next[0];
        continue;
      }
    }
    return { url: finalUrl, body };
  }
  throw new Error("VOE redirect limit exceeded");
}

function mapCaptions(captions) {
  if (!Array.isArray(captions)) return [];
  return captions.map((item) => {
    if (typeof item === "string") return { url: item, label: "Subtitle", srclang: "und", default: false };
    const url = item?.url ?? item?.src ?? item?.file;
    if (!url) return null;
    const label = item.label ?? item.language ?? item.lang ?? "Subtitle";
    return {
      url,
      label,
      srclang: item.srclang ?? item.lang ?? item.language ?? "und",
      default: Boolean(item.default),
    };
  }).filter(Boolean);
}

export async function extract(embedUrl, options = {}) {
  if (!canExtractVoe(embedUrl)) throw new Error(`Not a supported VOE embed: ${embedUrl}`);
  const page = await resolvePage(embedUrl, options);
  const payload = page.body.match(/<script[^>]*type\s*=\s*["']application\/json["'][^>]*>\s*(\[[\s\S]*?\])\s*<\/script>/i);
  if (!payload) throw new Error("VOE source payload not found");
  const records = JSON.parse(payload[1]);
  if (!Array.isArray(records) || !records.length || typeof records[0] !== "string") throw new Error("VOE source payload has an unexpected shape");
  const config = decodePayload(records[0]);
  const hls = config?.source;
  if (typeof hls !== "string" || !/^https?:\/\//i.test(hls)) throw new Error("VOE payload has no HLS source URL");
  return {
    embedPage: page.url,
    title: config.title ?? null,
    hls,
    thumbnail: config.thumbnail ?? null,
    direct: config.direct_access_url ?? null,
    captions: mapCaptions(config.captions),
    audio: Array.isArray(config.audio_languages) ? config.audio_languages : [],
  };
}

export async function extractVoe(embedUrl, options = {}) {
  const details = await extract(embedUrl, options);
  return [{
    url: details.hls,
    type: "hls",
    server: "VOE",
    referer: `${new URL(String(embedUrl)).origin}/`,
    subtitles: details.captions,
    title: details.title,
  }];
}

export async function variants(masterUrl, options = {}) {
  const response = await get(masterUrl, options);
  const text = await response.text();
  const base = new URL(masterUrl);
  const result = [];
  let streamInfo = null;
  for (const line of text.split(/\r?\n/).map((value) => value.trim())) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const bandwidth = line.match(/(?:^|,)BANDWIDTH=(\d+)/);
      const resolution = line.match(/(?:^|,)RESOLUTION=(\d+x\d+)/);
      streamInfo = {
        bandwidth: bandwidth ? Number(bandwidth[1]) : null,
        resolution: resolution?.[1] ?? null,
      };
    } else if (line && !line.startsWith("#") && streamInfo) {
      result.push({ ...streamInfo, url: new URL(line, base).href });
      streamInfo = null;
    }
  }
  return result;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const embedUrl = process.argv[2];
  if (!embedUrl) {
    console.error("usage: node extractors/voe.js <embedUrl>");
    process.exit(1);
  }
  const result = await extract(embedUrl);
  result.variants = await variants(result.hls);
  console.log(JSON.stringify(result, null, 2));
}
