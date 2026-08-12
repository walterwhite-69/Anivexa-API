import {
  getAsync, setAsync, isFresh, needsRefresh,
  episodeTTL, jikanPageTTL,
} from "./smartcache.js";
import { getEpisodes as mkissaEpisodes } from "../providers/mkissa.js";
import { getEpisodes as reanimeEpisodes } from "../providers/reanime.js";
import { getEpisodes as anikotoEpisodes } from "../providers/anikoto.js";
import { getEpisodes as animeggEpisodes } from "../providers/animegg.js";
import { getEpisodes as aninekoEpisodes } from "../providers/anineko.js";
import { getEpisodes as anidbappEpisodes } from "../providers/anidbapp.js";
import { getEpisodes as dhiveEpisodes } from "../providers/2dhive.js";
import { getEpisodes as animenosubEpisodes } from "../providers/animenosub.js";
import { getEpisodes as anizoneEpisodes } from "../providers/anizone.js";
import { getEpisodes as anibdEpisodes   } from "../providers/anibd.js";
import { getEpisodes as senshiEpisodes } from "../providers/senshi.js";
import { getEpisodes as kaaEpisodes    } from "../providers/kickassanime.js";
import { getEpisodes as animedunyaEpisodes } from "../providers/animedunya.js";
const JIKAN = "https://api.jikan.moe/v4";
const UA    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const inflight  = new Map();
const bgRunning = new Set();

function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function bg(key, fn) {
  if (bgRunning.has(key)) return;
  bgRunning.add(key);
  Promise.resolve()
    .then(fn)
    .catch(e => console.error(`[bg:${key}]`, e.message))
    .finally(() => bgRunning.delete(key));
}

async function jikanPage(malId, pageNum, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(
      `${JIKAN}/anime/${malId}/episodes?page=${pageNum}`,
      { headers: { "User-Agent": UA, Accept: "application/json" } }
    ).catch(() => null);

    if (!res) return null;
    if (res.status === 429) {
      const wait = (parseInt(res.headers.get("Retry-After") ?? "1") || 1) * 1000
                 + attempt * 600;
      if (attempt < retries) { await new Promise(r => setTimeout(r, wait)); continue; }
      return null;
    }
    if (!res.ok) return null;
    return res.json();
  }
  return null;
}

export function fetchAllJikanWithCache(malId, status) {
  return dedupe(`jikan:${malId}`, () => _jikanAll(malId, status));
}

async function _jikanAll(malId, status) {
  const metaKey = `jm:${malId}`;
  const meta    = await getAsync(metaKey);

  const isFinished      = status === "FINISHED";
  const mustCheckTotal  = !isFinished && (!meta || needsRefresh(meta));
  let   lastPage        = meta?.data?.lastPage ?? null;

  if (mustCheckTotal || !lastPage) {
    const p1 = await jikanPage(malId, 1);

    if (!p1 && !lastPage) return [];
    if (!p1 && lastPage)  return _buildPages(malId, lastPage, status);

    const newLast  = p1.pagination?.last_visible_page ?? 1;
    const isP1Last = newLast === 1;

    const [p1ttl, p1ref] = jikanPageTTL(isP1Last, status);
    await setAsync(`jp:${malId}:1`, p1.data ?? [], p1ttl, p1ref);

    if (lastPage && newLast > lastPage) {
      const [stableTtl] = jikanPageTTL(false, "FINISHED");
      const oldLastEntry = await getAsync(`jp:${malId}:${lastPage}`);
      if (oldLastEntry) await setAsync(`jp:${malId}:${lastPage}`, oldLastEntry.data, stableTtl, Infinity);

      await Promise.all(
        Array.from({ length: newLast - lastPage }, (_, i) => {
          const pn     = lastPage + 1 + i;
          const isLast = pn === newLast;
          return jikanPage(malId, pn).then(pd => {
            const [t, r] = jikanPageTTL(isLast, status);
            return setAsync(`jp:${malId}:${pn}`, pd?.data ?? [], t, r);
          });
        })
      );
    }

    const [mttl, mref] = episodeTTL(status);
    await setAsync(metaKey, { lastPage: newLast }, mttl, mref);
    lastPage = newLast;
  }

  return _buildPages(malId, lastPage, status);
}

async function _buildPages(malId, lastPage, status) {
  const pages = await Promise.all(
    Array.from({ length: lastPage }, (_, i) => i + 1).map(async pn => {
      const key    = `jp:${malId}:${pn}`;
      const isLast = pn === lastPage;
      const entry  = await getAsync(key);

      if (isFresh(entry)) {
        if (isLast && status === "RELEASING" && needsRefresh(entry)) {
          bg(key, async () => {
            const pd = await jikanPage(malId, pn);
            if (pd) {
              const [t, r] = jikanPageTTL(true, status);
              await setAsync(key, pd.data ?? [], t, r);
            }
          });
        }
        return entry.data;
      }

      const pd   = await jikanPage(malId, pn);
      const data = pd?.data ?? [];
      const [t, r] = jikanPageTTL(isLast, status);
      await setAsync(key, data, t, r);
      return data;
    })
  );

  return pages.flat();
}

async function withCache(key, status, fetchFn) {
  const [ttl, refreshAfter] = episodeTTL(status);
  const entry = await getAsync(key);

  if (isFresh(entry)) {
    if (needsRefresh(entry)) {
      bg(key, async () => {
        const data = await fetchFn();
        await setAsync(key, data, ttl, refreshAfter);
      });
    }
    return entry.data;
  }

  const data = await fetchFn();
  await setAsync(key, data, ttl, refreshAfter);
  return data;
}

async function safe(label, fn) {
  try   { return { ok: true,  data: await fn() }; }
  catch (e) { console.error(`[ep:${label}]`, e.message); return { ok: false, error: e.message, stack: e.stack }; }
}

const PROVIDER_ALIASES = {
  mkissa: "mkissa",
  reanime:  "reanime",
  anikoto:  "anikoto",
  animegg:  "animegg",
  anineko:  "anineko",
  anidbapp: "anidbapp",
  "2dhive": "2dhive",
  animenosub: "animenosub",
  anizone: "anizone",
  anibd:  "anibd",
  senshi: "senshi",
  kaa:    "kaa",
  animedunya: "animedunya",
};

export function resolveProviders(rawNames) {
  const resolved = new Set();
  const unknown  = [];
  for (const raw of rawNames) {
    const name = PROVIDER_ALIASES[raw.toLowerCase()];
    if (name) resolved.add(name);
    else unknown.push(raw);
  }
  return { resolved, unknown };
}

function providerFns(anilistId, status, ctx) {
  return {
    mkissa: () => withCache(`epv:mkissa:${anilistId}`, status, () => mkissaEpisodes(anilistId, ctx)),
    reanime:  () => withCache(`epv:reanime:${anilistId}`, status, () => reanimeEpisodes(anilistId, ctx)),
    anikoto:  () => withCache(`epv:anikoto:${anilistId}`, status, () => anikotoEpisodes(anilistId, ctx)),
    animegg:  () => withCache(`epv:animegg:${anilistId}`, status, () => animeggEpisodes(anilistId, ctx)),
    anineko:  () => withCache(`epv:anineko:${anilistId}`, status, () => aninekoEpisodes(anilistId, ctx)),
    anidbapp: () => withCache(`epv:anidbapp:${anilistId}`, status, () => anidbappEpisodes(anilistId, ctx)),
    "2dhive": () => withCache(`epv:2dhive:${anilistId}`,  status, () => dhiveEpisodes(anilistId, ctx)),
    animenosub: () => withCache(`epv:animenosub:${anilistId}`, status, () => animenosubEpisodes(anilistId, ctx)),
    anizone: () => withCache(`epv:anizone:${anilistId}`, status, () => anizoneEpisodes(anilistId, ctx)),
    anibd:  () => withCache(`epv:anibd:${anilistId}`,   status, () => anibdEpisodes(anilistId, ctx)),
    senshi: () => withCache(`epv:senshi:${anilistId}`,  status, () => senshiEpisodes(anilistId, ctx)),
    kaa:    () => withCache(`epv:kaa:${anilistId}`,     status, () => kaaEpisodes(anilistId, ctx)),
    animedunya: () => withCache(`epv:animedunya:${anilistId}`, status, () => animedunyaEpisodes(anilistId, ctx)),
  };
}

export async function buildFilteredEpisodesWithCache(anilistId, providers, media, anizip) {
  const status = media?.status ?? "RELEASING";
  const malId  = media?.idMal  ?? null;

  const jikanEps = malId
    ? await fetchAllJikanWithCache(malId, status).catch(() => null)
    : null;

  const ctx  = { media, anizip, jikanEps, maxPages: undefined };
  const fns  = providerFns(anilistId, status, ctx);

  const pairs = await Promise.all(
    [...providers].map(async (name) => {
      const result = await safe(name, fns[name]);
      return [name, result.ok ? result.data : { error: result.error, stack: result.stack }];
    })
  );

  return Object.fromEntries(pairs);
}

export async function buildEpisodesWithCache(anilistId, media, anizip) {
  const status = media?.status ?? "RELEASING";
  const malId  = media?.idMal  ?? null;

  const jikanEps = malId
    ? await fetchAllJikanWithCache(malId, status).catch(() => null)
    : null;

  const ctx = { media, anizip, jikanEps, maxPages: undefined };

  const [mkissa, reanime, anikoto, animegg, anineko, anidbapp, dhive, animenosub, anizone, anibd, senshi, kaa, animedunya] = await Promise.all([
    safe("mkissa",     () => withCache(`epv:mkissa:${anilistId}`,     status, () => mkissaEpisodes(anilistId, ctx))),
    safe("reanime",    () => withCache(`epv:reanime:${anilistId}`,    status, () => reanimeEpisodes(anilistId, ctx))),
    safe("anikoto",    () => withCache(`epv:anikoto:${anilistId}`,    status, () => anikotoEpisodes(anilistId, ctx))),
    safe("animegg",    () => withCache(`epv:animegg:${anilistId}`,    status, () => animeggEpisodes(anilistId, ctx))),
    safe("anineko",    () => withCache(`epv:anineko:${anilistId}`,    status, () => aninekoEpisodes(anilistId, ctx))),
    safe("anidbapp",   () => withCache(`epv:anidbapp:${anilistId}`,   status, () => anidbappEpisodes(anilistId, ctx))),
    safe("2dhive",     () => withCache(`epv:2dhive:${anilistId}`,     status, () => dhiveEpisodes(anilistId, ctx))),
    safe("animenosub", () => withCache(`epv:animenosub:${anilistId}`, status, () => animenosubEpisodes(anilistId, ctx))),
    safe("anizone",    () => withCache(`epv:anizone:${anilistId}`,    status, () => anizoneEpisodes(anilistId, ctx))),
    safe("anibd",      () => withCache(`epv:anibd:${anilistId}`,      status, () => anibdEpisodes(anilistId, ctx))),
    safe("senshi",     () => withCache(`epv:senshi:${anilistId}`,     status, () => senshiEpisodes(anilistId, ctx))),
    safe("kaa",        () => withCache(`epv:kaa:${anilistId}`,        status, () => kaaEpisodes(anilistId, ctx))),
    safe("animedunya", () => withCache(`epv:animedunya:${anilistId}`, status, () => animedunyaEpisodes(anilistId, ctx))),
  ]);

  return {
    mkissa:      mkissa.ok      ? mkissa.data      : { error: mkissa.error,      stack: mkissa.stack },
    reanime:     reanime.ok     ? reanime.data     : { error: reanime.error,     stack: reanime.stack },
    anikoto:     anikoto.ok     ? anikoto.data     : { error: anikoto.error,     stack: anikoto.stack },
    animegg:     animegg.ok     ? animegg.data     : { error: animegg.error,     stack: animegg.stack },
    anineko:     anineko.ok     ? anineko.data     : { error: anineko.error,     stack: anineko.stack },
    anidbapp:    anidbapp.ok    ? anidbapp.data    : { error: anidbapp.error,    stack: anidbapp.stack },
    "2dhive":    dhive.ok       ? dhive.data       : { error: dhive.error,       stack: dhive.stack },
    animenosub:  animenosub.ok  ? animenosub.data  : { error: animenosub.error,  stack: animenosub.stack },
    anizone:     anizone.ok     ? anizone.data     : { error: anizone.error,     stack: anizone.stack },
    anibd:       anibd.ok       ? anibd.data       : { error: anibd.error,       stack: anibd.stack },
    senshi:      senshi.ok      ? senshi.data      : { error: senshi.error,      stack: senshi.stack },
    kaa:         kaa.ok         ? kaa.data         : { error: kaa.error,         stack: kaa.stack },
    animedunya:  animedunya.ok  ? animedunya.data  : { error: animedunya.error,  stack: animedunya.stack },
  };
}
