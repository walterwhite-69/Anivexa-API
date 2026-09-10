import { get, set, isFresh, SHOW_IDENTITY_TTL } from "./smartcache.js";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const RELATION_FRAGMENT = `edges{relationType(version:2) node{id type episodes relations{edges{relationType(version:2) node{id type episodes relations{edges{relationType(version:2) node{id type episodes relations{edges{relationType(version:2) node{id type episodes}}}}}}}}}}}`;

export async function fetchHtml(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...headers,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

export function decodeEntities(s = "") {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function stripTags(html = "") {
  return decodeEntities(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

export function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

export function norm(s = "") {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function diceCoeff(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const bigrams = new Map();
  for (let i = 0; i < na.length - 1; i++) {
    const bg = na.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    const bg = nb.slice(i, i + 2);
    const count = bigrams.get(bg) ?? 0;
    if (count > 0) {
      hits++;
      bigrams.set(bg, count - 1);
    }
  }
  return (2 * hits) / (na.length + nb.length - 2);
}

export function titleScore(query, candidate, slug) {
  const base = Math.max(diceCoeff(query, candidate), diceCoeff(query, slug.replace(/-/g, " ")));
  const queryFirstNum = norm(query).match(/\d+/)?.[0] ?? "";
  const slugFirstNum = slug.match(/\d+/)?.[0] ?? "";
  if (queryFirstNum && slugFirstNum && queryFirstNum !== slugFirstNum) return base * 0.65;
  if (queryFirstNum && !slugFirstNum) return base * 0.65;
  if (!queryFirstNum && slugFirstNum) {
    const n = parseInt(slugFirstNum);
    if (n > 1 && n < 1900) return base * (1 - 0.06 * (n - 1));
  }
  const isMovieQuery = /\b(movie|film|the movie)\b/i.test(query);
  const isMovieMatch = /\b(movie|film)\b/i.test(candidate) || /movie|film/.test(slug);
  if (isMovieQuery && !isMovieMatch) return base * 0.4;
  const qLen = norm(query).length;
  const sLen = norm(slug.replace(/-/g, " ")).length;
  return sLen > qLen * 1.6 + 4 ? base * 0.8 : base;
}

function buildSearchQueries(title) {
  const queries = new Set([title]);
  const words = title.trim().split(/\s+/);
  if (words.length > 4) queries.add(words.slice(0, 4).join(" "));
  if (words.length > 3) queries.add(words.slice(0, 3).join(" "));
  const stripped = title
    .replace(/\bseason\s*\d+\b/gi, "")
    .replace(/\bpart\s*\d+\b/gi, "")
    .replace(/\b\d+rd\b|\b\d+th\b|\b\d+st\b|\b\d+nd\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped && stripped !== title) queries.add(stripped);
  return [...queries].filter((q) => q.length >= 3);
}

export async function findTopSlugs(titles, searchFn, n = 6) {
  const allCandidates = new Map();
  const searchQueries = new Set();
  for (const title of titles.slice(0, 4)) {
    for (const q of buildSearchQueries(title)) searchQueries.add(q);
  }
  await Promise.all([...searchQueries].map(async (q) => {
    try {
      const results = await searchFn(q);
      for (const r of results) if (!allCandidates.has(r.slug)) allCandidates.set(r.slug, r.text);
    } catch {}
  }));
  const scored = [];
  for (const [slug, text] of allCandidates) {
    let best = 0;
    for (const title of titles.slice(0, 2)) best = Math.max(best, titleScore(title, text, slug));
    if (best >= 0.5) scored.push({ slug, title: text, score: best });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, n);
}

async function anilistQuery(query, variables) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`AniList: ${json.errors[0].message}`);
  return json.data;
}

function computePrequelOffset(relations, depth = 0) {
  if (!relations || depth > 5) return 0;
  const prequelEdge = relations.edges?.find(
    (e) => e.relationType === "PREQUEL" && e.node.type === "ANIME" && (e.node.episodes ?? 0) >= 5
  );
  if (!prequelEdge) return 0;
  return (prequelEdge.node.episodes ?? 0) + computePrequelOffset(prequelEdge.node.relations, depth + 1);
}

export async function getPrequelOffset(anilistId) {
  const key = `np-offset:${anilistId}`;
  const entry = get(key);
  if (isFresh(entry)) return entry.data;
  const data = await anilistQuery(
    `query($id:Int){Media(id:$id,type:ANIME){relations{${RELATION_FRAGMENT}}}}`,
    { id: Number(anilistId) }
  );
  const offset = computePrequelOffset(data?.Media?.relations);
  set(key, offset, SHOW_IDENTITY_TTL);
  return offset;
}

export function buildTitles(media, anizip) {
  return [
    media?.title?.english,
    media?.title?.romaji,
    media?.title?.native,
    ...(media?.synonyms ?? []),
    anizip?.titles?.en,
    anizip?.titles?.["x-jat"],
    anizip?.titles?.ja,
  ].filter(Boolean);
}

export function expectedCount(media, anizip) {
  const counts = [
    media?.episodes,
    ...Object.keys(anizip?.episodes ?? {}).map(Number).filter(Number.isFinite),
  ].filter((n) => Number.isFinite(n) && n > 0);
  return counts.length ? Math.max(...counts) : null;
}

export function episodeMeta(n, ctx) {
  const az = ctx.anizip?.episodes?.[String(n)] ?? {};
  const runtime = az.runtime ?? az.length ?? null;
  return {
    title: az.title?.en ?? az.title?.["x-jat"] ?? null,
    duration: runtime ? runtime * 60 : null,
    filler: az.filler ?? false,
    uncensored: false,
    description: az.overview ?? az.summary ?? null,
    image: az.image ?? ctx.anizip?.images?.cover ?? null,
    airDate: az.airdate ?? az.aired ?? null,
  };
}

export function selectSeries(candidates, scrapeSeries, expected, status, offset, options = {}) {
  return Promise.all(candidates.map(async (candidate) => {
    const episodes = await scrapeSeries(candidate.slug);
    const max = Math.max(0, ...episodes.map((e) => e.number));
    const localHits = expected ? episodes.filter((e) => e.number >= 1 && e.number <= expected).length : episodes.length;
    const offsetHits = expected && offset
      ? episodes.filter((e) => e.number > offset && e.number <= offset + expected).length
      : 0;
    const mode = offsetHits > localHits ? "offset" : "local";
    const hits = Math.max(localHits, offsetHits);
    let countScore = 1;
    if (expected && expected >= 6) {
      const needed = status === "FINISHED" ? Math.ceil(expected * 0.9) : Math.max(1, expected - 3);
      countScore = hits >= needed ? 1 : hits / needed;
    }
    return { ...candidate, episodes, max, mode, score: candidate.score * 0.7 + countScore * 0.3 };
  })).then((results) => {
    const minScore = options.minScore ?? 0.65;
    const viable = results
      .filter((r) => r.episodes.length && r.score >= minScore)
      .sort((a, b) => b.score - a.score);
    if (!viable.length) return null;
    return viable[0];
  });
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}
