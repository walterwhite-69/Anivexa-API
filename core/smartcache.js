// Cache configuration is env-driven so no secrets live in source (see
// .env.example). Set these in Vercel → Project → Environment Variables:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  → shared cache
//   CACHE_ENABLED=false                               → kill switch (default on)
// Without Upstash creds the layer still runs (in-memory per warm instance;
// disk cache under local node) — it just can't share across instances.
const ENV = typeof process !== "undefined" && process.env ? process.env : {};

export const _CACHE_ENABLED = String(ENV.CACHE_ENABLED ?? "true").toLowerCase() !== "false";

const IS_LOCAL_NODE = (() => {
  try {
    return (
      typeof process !== "undefined" &&
      typeof process.versions?.node === "string" &&
      !process.env.VERCEL
    );
  } catch { return false; }
})();

const UPSTASH_REDIS_REST_URL = ENV.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = ENV.UPSTASH_REDIS_REST_TOKEN || "";
export const _REDIS_ENABLED = Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
const REDIS_ENABLED = _REDIS_ENABLED;

function encodeEntry(entry) {
  return JSON.stringify(entry, (_, value) => value === Infinity ? "__Infinity__" : value);
}

function decodeEntry(raw) {
  return JSON.parse(raw, (_, value) => value === "__Infinity__" ? Infinity : value);
}

async function redisCommand(command) {
  if (!REDIS_ENABLED || typeof fetch !== "function") return null;
  const res = await fetch(UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  }).catch(() => null);
  if (!res?.ok) return null;
  const json = await res.json().catch(() => null);
  return json?.result ?? null;
}

async function redisWrite(key, entry) {
  if (!REDIS_ENABLED) return;
  const value = encodeEntry(entry);
  if (Number.isFinite(entry.ttl) && entry.ttl > 0) {
    await redisCommand(["SET", key, value, "PX", Math.ceil(entry.ttl)]);
    return;
  }
  await redisCommand(["SET", key, value]);
}

let diskRead  = () => null;
let diskWrite = () => {};
let diskDel   = () => {};

if (IS_LOCAL_NODE) {
  const { readFileSync, mkdirSync, existsSync } = await import("node:fs");
  const { writeFile, unlink }                   = await import("node:fs/promises");
  const { join, dirname }                        = await import("node:path");
  const { fileURLToPath }                        = await import("node:url");

  const __dir    = dirname(fileURLToPath(import.meta.url));
  const CACHE_DIR = join(__dir, ".cache");
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

  const keyToPath = (key) =>
    join(CACHE_DIR, key.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");

  diskRead = (key) => {
    try {
      const p = keyToPath(key);
      if (!existsSync(p)) return null;
      return decodeEntry(readFileSync(p, "utf8"));
    } catch { return null; }
  };

  diskWrite = (key, entry) => {
    writeFile(keyToPath(key), encodeEntry(entry)).catch(() => {});
  };

  diskDel = (key) => {
    unlink(keyToPath(key)).catch(() => {});
  };
}

const MAX_MEM = 800;
const mem     = new Map();

function evict() {
  if (mem.size <= MAX_MEM) return;
  const drop = mem.size - MAX_MEM;
  let   n    = 0;
  for (const k of mem.keys()) {
    if (n++ >= drop) break;
    mem.delete(k);
  }
}

export function get(key) {
  if (!_CACHE_ENABLED) return null;
  let e = mem.get(key);
  if (e) return e;

  e = diskRead(key);
  if (!e) return null;

  mem.set(key, e);
  evict();
  return e;
}

export async function getAsync(key) {
  if (!_CACHE_ENABLED) return null;
  let e = get(key);
  if (e) return e;

  const raw = await redisCommand(["GET", key]);
  if (!raw) return null;

  try {
    e = typeof raw === "string" ? decodeEntry(raw) : raw;
    if (!isFresh(e)) {
      await delAsync(key);
      return null;
    }
    mem.set(key, e);
    evict();
    diskWrite(key, e);
    return e;
  } catch {
    return null;
  }
}

function setLocal(key, data, ttlMs, refreshAfterMs) {
  const now   = Date.now();
  const entry = {
    data,
    cachedAt:     now,
    ttl:          ttlMs,
    refreshAfter: refreshAfterMs ?? ttlMs,
    expiresAt:    now + ttlMs,
  };
  mem.delete(key);
  mem.set(key, entry);
  evict();
  diskWrite(key, entry);
  return entry;
}

export function set(key, data, ttlMs, refreshAfterMs) {
  if (!_CACHE_ENABLED) return { data, cachedAt: Date.now(), ttl: ttlMs, refreshAfter: refreshAfterMs ?? ttlMs, expiresAt: Date.now() + ttlMs };
  const entry = setLocal(key, data, ttlMs, refreshAfterMs);
  redisWrite(key, entry).catch(() => {});
  return entry;
}

export async function setAsync(key, data, ttlMs, refreshAfterMs) {
  if (!_CACHE_ENABLED) return { data, cachedAt: Date.now(), ttl: ttlMs, refreshAfter: refreshAfterMs ?? ttlMs, expiresAt: Date.now() + ttlMs };
  const entry = setLocal(key, data, ttlMs, refreshAfterMs);
  await redisWrite(key, entry);
  return entry;
}

export function isFresh(entry) {
  return entry !== null && entry !== undefined && Date.now() < entry.expiresAt;
}

export function needsRefresh(entry) {
  return !entry || Date.now() - entry.cachedAt > entry.refreshAfter;
}

function delLocal(key) {
  mem.delete(key);
  diskDel(key);
}

export function del(key) {
  delLocal(key);
  redisCommand(["DEL", key]).catch(() => {});
}

export async function delAsync(key) {
  delLocal(key);
  await redisCommand(["DEL", key]);
}

export function delByPrefix(prefix) {
  for (const k of [...mem.keys()]) {
    if (k.startsWith(prefix)) mem.delete(k);
  }
}

export async function delByPrefixAsync(prefix) {
  delByPrefix(prefix);
  const keys = await redisCommand(["KEYS", `${prefix}*`]);
  if (Array.isArray(keys) && keys.length) {
    await redisCommand(["DEL", ...keys]);
  }
}

const MIN  = 60_000;
const HOUR = 60 * MIN;
const DAY  = 24 * HOUR;

export function episodeTTL(status) {
  switch (status) {
    case "FINISHED":         return [7 * DAY,   Infinity];
    case "RELEASING":        return [2 * HOUR,  15 * MIN];
    case "HIATUS":           return [6 * HOUR,  60 * MIN];
    case "NOT_YET_RELEASED": return [30 * MIN,  15 * MIN];
    default:                 return [HOUR,       15 * MIN];
  }
}

export function jikanPageTTL(isLastPage, status) {
  if (!isLastPage || status === "FINISHED") return [7 * DAY, Infinity];
  switch (status) {
    case "RELEASING":        return [2 * HOUR,  15 * MIN];
    case "HIATUS":           return [6 * HOUR,  60 * MIN];
    case "NOT_YET_RELEASED": return [30 * MIN,  15 * MIN];
    default:                 return [2 * HOUR,  15 * MIN];
  }
}

export function mapTTL(status) {
  return status === "FINISHED" ? 30 * DAY : 12 * HOUR;
}

export const WATCH_TTL         = 3 * HOUR;
export const SHOW_IDENTITY_TTL = 24 * HOUR;
export const THIRTY_DAYS       = 30 * DAY;
