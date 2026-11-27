import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import animeheaven, { getEpisodes, parseEpisodes, parseGateSources, parseSearchResults } from "../providers/animeheaven.js";

test("AnimeHeaven search parsing reads ids, titles and images", () => {
  const html = `
    <a href="anime.php?x1y2z"><img src="/images/a.jpg" alt="Alt Title"><div class="fastname">Fixture &amp; Show</div></a>
    <a href='anime.php?onlyalt'><img src="https://img.example/b.jpg" alt="Alt Only"></a>
    <a href="anime.php?notitle"></a>
    <a href="/about.php"><div class="fastname">Not an anime link</div></a>`;
  assert.deepEqual(parseSearchResults(html), [
    { id: "x1y2z", title: "Fixture & Show", image: "https://animeheaven.me/images/a.jpg" },
    { id: "onlyalt", title: "Alt Only", image: "https://img.example/b.jpg" },
  ]);
});

test("AnimeHeaven episode parsing accepts every known gate markup style", () => {
  const html = `
    <a class="ep" onmouseover="gatea('key-one')"><div class="watch2">01</div></a>
    <a class="ep" onclick='gateh("key-two")'><div class="watch2">2</div></a>
    <a href="gate.php?key=key%2Fthree">Episode 3</a>
    <a onclick="gatea(key4)">4</a>
    <a onmouseover="gatea('key-twelve-half')"><div class="watch2">12.5</div></a>
    <a onmouseover="gatea('key-dup')"><div class="watch2">2</div></a>
    <a onmouseover="gatea('key-nonum')"></a>
    <a href="anime.php?id=related">Related episode list</a>`;
  assert.deepEqual(parseEpisodes(html).map(({ number, key }) => [number, key]), [
    [1, "key-one"],
    [2, "key-two"],
    [3, "key/three"],
    [4, "key4"],
  ]);
});

test("AnimeHeaven gate parsing rejects the placeholder player and decodes source URLs", () => {
  assert.equal(parseGateSources("<html><title>Watch Episode on animeheaven.me</title><body>Loading</body></html>"), null);
  assert.deepEqual(parseGateSources("<html><body><video></video></body></html>"), []);
  assert.deepEqual(
    parseGateSources(`<video controls>
      <source src="https://cdn.example/a.m3u8" type="application/x-mpegURL">
      <source src="https://cdn.example/v.mp4?a=1&amp;b=2" type="video/mp4">
      <source src="/relative.mp4"><source src="//cdn.example/b.mp4">
    </video>`),
    ["https://cdn.example/v.mp4?a=1&b=2", "https://cdn.example/b.mp4", "https://cdn.example/a.m3u8"],
  );
});

// ---------------------------------------------------------------------------
// End to end with the network stubbed: matching -> episode list -> watch route
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const SEARCH_HTML = `
  <a href="anime.php?dubid"><div class="fastname">Fixture Show (Dub)</div></a>
  <a href="anime.php?x1y2z"><img src="/a.jpg"><div class="fastname">Fixture Show</div></a>
  <a href="anime.php?other"><div class="fastname">Completely Different</div></a>`;
const ANIME_HTML = ["1", "2", "3"].map((n) => `<a onmouseover="gatea('episode-key-${n}')"><div class="watch2">${n}</div></a>`).join("\n");
const DUB_ANIME_HTML = `<a onmouseover="gatea('dub-key-1')"><div class="watch2">1</div></a>`;

test("AnimeHeaven resolves a series, lists sub episodes and serves a watch route", async () => {
  const gateRequests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "arm.haglund.dev") return new Response("{}", { status: 404 });
    if (url.hostname === "graphql.anilist.co") {
      return Response.json({ data: { Media: {
        id: 999001, idMal: null, title: { english: "Fixture Show", romaji: "Fixture Show", native: null },
        status: "FINISHED", format: "TV", episodes: 3, synonyms: [], genres: [], relations: { edges: [] },
      } } });
    }
    assert.equal(url.hostname, "animeheaven.me", `unexpected request to ${url}`);
    if (url.pathname === "/fastsearch.php") {
      return new Response(url.searchParams.get("s")?.toLowerCase().includes("fixture") ? SEARCH_HTML : "", {
        headers: [["set-cookie", "PHPSESSID=session123; path=/; HttpOnly"]],
      });
    }
    if (url.pathname === "/anime.php") {
      assert.equal(url.search, url.search.replace("=", ""), "anime id must be sent as a bare query string");
      return new Response(url.search === "?x1y2z" ? ANIME_HTML : DUB_ANIME_HTML);
    }
    if (url.pathname === "/gate.php") {
      const headers = new Headers(init.headers);
      gateRequests.push(headers.get("cookie"));
      if (headers.get("cookie")?.includes("key=episode-key-3")) {
        return new Response("<html><title>Watch Episode on animeheaven.me</title></html>");
      }
      return new Response(`<video><source src="https://cdn.example/${headers.get("cookie")?.match(/key=([^;]+)/)?.[1]}.mp4?a=1&amp;b=2"></video>`);
    }
    return new Response("Not found", { status: 404 });
  };

  const listing = await getEpisodes("999001");
  assert.equal(listing.meta.source, "animeheaven");
  assert.equal(listing.meta.id, "x1y2z", "the dub entry must not be matched as the sub series");
  assert.deepEqual(listing.episodes.sub.map((episode) => [episode.number, episode.id]), [
    [1, "watch/animeheaven/999001/sub/animeheaven-1"],
    [2, "watch/animeheaven/999001/sub/animeheaven-2"],
    [3, "watch/animeheaven/999001/sub/animeheaven-3"],
  ]);
  assert.deepEqual(listing.episodes.dub, []);

  const watch = async (path) => animeheaven.fetch(new Request(`https://anivexa.local${path}`));

  const ok = await watch("/watch/animeheaven/999001/sub/animeheaven-2");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    anilistId: 999001,
    episode: 2,
    providerEpisode: 2,
    audio: "sub",
    streams: [{
      url: "https://cdn.example/episode-key-2.mp4?a=1&b=2",
      type: "mp4",
      server: "AnimeHeaven",
      audio: "sub",
      referer: "https://animeheaven.me/",
      priority: 1,
      isActive: true,
    }],
  });
  // The session cookie captured from earlier responses is replayed together with this episode's key.
  assert.match(gateRequests[0], /PHPSESSID=session123/);
  assert.match(gateRequests[0], /key=episode-key-2/);

  // A different episode must carry only its own key: it is never stored in the shared jar.
  await watch("/watch/animeheaven/999001/sub/animeheaven-1");
  assert.match(gateRequests[1], /key=episode-key-1/);
  assert.doesNotMatch(gateRequests[1], /episode-key-2/);

  const placeholder = await watch("/watch/animeheaven/999001/sub/animeheaven-3");
  assert.equal(placeholder.status, 404);
  assert.match((await placeholder.json()).error, /no playable source/);

  const missing = await watch("/watch/animeheaven/999001/sub/animeheaven-9");
  assert.equal(missing.status, 404);

  const dub = await watch("/watch/animeheaven/999001/dub/animeheaven-1");
  assert.equal(dub.status, 404);
  assert.match((await dub.json()).error, /only provides sub/);
});

test("AnimeHeaven retries a spaced title as a compact query when the fast search finds nothing", async () => {
  const queries = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "arm.haglund.dev") return new Response("{}", { status: 404 });
    if (url.hostname === "graphql.anilist.co") {
      return Response.json({ data: { Media: {
        id: 999002, idMal: null, title: { english: "Mob Psycho", romaji: "Mob Psycho", native: null },
        status: "FINISHED", format: "TV", episodes: 1, synonyms: [], genres: [], relations: { edges: [] },
      } } });
    }
    if (url.pathname === "/fastsearch.php") {
      const s = url.searchParams.get("s");
      queries.push(s);
      return new Response(s === "mobpsycho" ? `<a href="anime.php?mob1"><div class="fastname">Mobpsycho</div></a>` : "");
    }
    if (url.pathname === "/anime.php") return new Response(`<a onmouseover="gatea('k1')"><div class="watch2">1</div></a>`);
    return new Response("Not found", { status: 404 });
  };
  const listing = await getEpisodes("999002");
  assert.equal(listing.meta.id, "mob1");
  assert.ok(queries.includes("mobpsycho"));
});
