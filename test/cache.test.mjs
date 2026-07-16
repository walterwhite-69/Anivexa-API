// Forced-scenario tests for the env-driven cache (core/smartcache.js).
// Mocks globalThis.fetch to emulate Upstash's REST API so we exercise the
// enabled / cold-read / disabled / redis-down paths without a real database.
//
//   node test/cache.test.mjs
//
// Each scenario loads a FRESH module instance (import with a cache-busting
// query) because config is read at module load from process.env.

const results = []
function check(name, cond) {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`)
}

// In-memory stand-in for Upstash. Understands the SET/GET/DEL commands
// smartcache issues via the REST protocol (POST body = ["SET", key, ...]).
function mockUpstash() {
  const store = new Map()
  let down = false
  globalThis.fetch = async (_url, opts) => {
    if (down) throw new Error("ECONNREFUSED")
    const cmd = JSON.parse(opts.body)
    const [op, key, value] = cmd
    if (op === "SET") { store.set(key, value); return json({ result: "OK" }) }
    if (op === "GET") { return json({ result: store.has(key) ? store.get(key) : null }) }
    if (op === "DEL") { store.delete(key); return json({ result: 1 }) }
    return json({ result: null })
  }
  return {
    store,
    setDown(v) { down = v },
  }
}
function json(obj) {
  return { ok: true, status: 200, json: async () => obj }
}

async function loadFresh() {
  return import(`../core/smartcache.js?t=${Date.now()}_${Math.random()}`)
}

const REST_ENV = {
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}

// ── 1. Enabled + Redis configured: set → get round-trips ──────────────────
{
  Object.assign(process.env, REST_ENV, { CACHE_ENABLED: "true" })
  mockUpstash()
  const c = await loadFresh()
  check("config: _CACHE_ENABLED true", c._CACHE_ENABLED === true)
  check("config: _REDIS_ENABLED true when creds present", c._REDIS_ENABLED === true)
  await c.setAsync("watch:x", { streams: ["hls://a"] }, 3600_000)
  const got = await c.getAsync("watch:x")
  check("hit: getAsync returns the cached payload", got?.data?.streams?.[0] === "hls://a")
  check("hit: entry is fresh", c.isFresh(got) === true)
}

// ── 2. Cold read straight from Redis (nothing in this instance's memory) ──
{
  Object.assign(process.env, REST_ENV, { CACHE_ENABLED: "true" })
  const up = mockUpstash()
  // Prime Redis as if a *different* serverless instance wrote it: store the
  // encoded entry shape smartcache expects.
  const entry = { data: { ok: 1 }, cachedAt: Date.now(), ttl: 3600_000, refreshAfter: 3600_000, expiresAt: Date.now() + 3600_000 }
  up.store.set("map:42", JSON.stringify(entry))
  const c = await loadFresh()
  const got = await c.getAsync("map:42")
  check("cold: getAsync reads a value written by another instance", got?.data?.ok === 1)
}

// ── 3. Disabled kill switch: never caches, never reads ────────────────────
{
  Object.assign(process.env, REST_ENV, { CACHE_ENABLED: "false" })
  mockUpstash()
  const c = await loadFresh()
  check("config: _CACHE_ENABLED false honors kill switch", c._CACHE_ENABLED === false)
  await c.setAsync("watch:y", { streams: ["hls://b"] }, 3600_000)
  const got = await c.getAsync("watch:y")
  check("disabled: getAsync returns null (always live)", got === null)
}

// ── 4. Redis down: getAsync fails soft, no throw ──────────────────────────
{
  Object.assign(process.env, REST_ENV, { CACHE_ENABLED: "true" })
  const up = mockUpstash()
  const c = await loadFresh()
  up.setDown(true)
  let threw = false
  let got
  try { got = await c.getAsync("map:cold-miss") } catch { threw = true }
  check("redis-down: getAsync does not throw", threw === false)
  check("redis-down: getAsync returns null → caller goes live", got === null || got === undefined)
}

// ── 5. No creds: cache still runs, redis disabled ─────────────────────────
{
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  process.env.CACHE_ENABLED = "true"
  mockUpstash()
  const c = await loadFresh()
  check("no-creds: _REDIS_ENABLED false", c._REDIS_ENABLED === false)
  check("no-creds: _CACHE_ENABLED still true", c._CACHE_ENABLED === true)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
