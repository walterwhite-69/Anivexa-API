<div align="center">


<img src="docs/logo.svg" width="80" height="80"/>


# Anivexa API

**Anime streaming aggregator API — one endpoint, all your sources.**

![Views](https://visitor-badge.laobi.icu/badge?page_id=walterwhite-69.Anivexa-API)
[![GitHub stars](https://img.shields.io/github/stars/walterwhite-69/Anivexa-API?style=flat-square&color=yellow)](https://github.com/walterwhite-69/Anivexa-API/stargazers)


</div>

---

## What is this?

A single API that aggregates anime episode lists and streaming links from multiple providers. Give it an AniList ID, get back everything — episodes, sources, and stream URLs — all in one place.

## Notice!
***This API intentionally uses AniList as its catalog and identity layer. When AniList is unavailable, the API may be partially unavailable or unstable as well. If you do not want an AniList-backed catalog, this simply is not the API for your use case!. So dont bother using it.***

---

## Providers

Twelve providers are wired into the API. Coverage and stream availability vary by title and upstream site conditions.

| Provider | Highlights |
|---|---|
| **AniHQ** | Sub/dub catalogs; title and installment matching |
| **Reanime** | Broad catalog |
| **AniKoto** | Broad catalog |
| **AnimeGG** | Fuzzy title matching |
| **AnimeNoSub** | Sub and dub episodes |
| **AniZone** | Sub, HLS, and subtitles |
| **AniWaves** | HLS, MP4, and embed fallbacks |
| **Pahenime** | AniList-ID-verified catalog; sub/dub player embeds |
| **Kickassanime** | Fuzzy title matching |
| **AnimeDunya** | MAL-backed; sub, HLS, and subtitles |
| **AnimeOnsen** | AniList/MAL matching; sub, DASH, and subtitles |
| **Ani.pm** | Soft-sub and hard-sub variants |

---

## Local provider and extractor tests

The repository includes deterministic fixtures and a live integration test that runs against the provider and extractor code in your local checkout. The live test needs an internet connection, but it does not require a running API server or additional credentials.

```bash
npm test
npm run test:providers
```

The live test checks the provider registry, episode catalogs, a selected watch route per provider with a matching episode, registered embed extractors, and returned HLS, DASH, or media sources. It validates manifests or a bounded media response and reports whether a returned FlixCloud playlist key decrypts its manifest. It uses AniList ID `16498` by default; pass another title or restrict the run to selected providers:

```bash
npm run test:providers -- --anime-id 21
npm run test:providers -- --anime-id 21 --provider reanime,anihq
```

The report separates provider errors from titles with no matching episodes. A provider with no match is skipped for that title, so choose an AniList ID that exercises the sources you want to inspect. Authenticated stream URLs are reported as protected because the test does not forward authorization or cookie headers. Upstream availability can vary by network and time; a live result reflects the current run.

| Provider | API route name |
|---|---|
| AniHQ | `anihq` |
| Reanime | `reanime` |
| AniKoto | `anikoto` |
| AnimeGG | `animegg` |
| AnimeNoSub | `animenosub` |
| AniZone | `anizone` |
| AniWaves | `aniwaves` |
| Pahenime | `pahenime` |
| Kickassanime | `kaa` |
| AnimeDunya | `animedunya` |
| AnimeOnsen | `animeonsen` |
| Ani.pm | `anipm` |

The shared extractor inventory and deterministic fixture coverage are:

| Extractor | Coverage |
|---|---|
| Byse | Challenge flow and AES-GCM playback payload |
| DataSV | Embed URL matcher |
| FlixCloud | WASM-derived playlist key and AES-CBC stream payload |
| MegaPlay | Embed matcher and AES-CBC source payload |
| Nova | AES-128-CBC source payload |
| Vidmoly | Embed URL matcher |
| Vidplay | Embed URL matcher |
| VOE | Obfuscated source payload |

---

## Routes

```
GET /map/:anilistId
```
Returns cross-platform ID mappings — MAL, TVDB, TMDB, Kitsu, AniDB, and more.

```
GET /episodes/:anilistId
GET /episodes/:provider[/:provider...]/:anilistId
```
Returns episode lists in a single response with smart background refresh. Pass one or more provider names in the path to filter results — e.g. `/episodes/anizone/anihq/16498` returns only those two. Omit providers to get all of them.

```
GET /watch/:provider/:anilistId/sub|dub/:provider-:ep
```
Returns stream URLs for a specific episode from a specific provider.

```
GET /stream/reanime/:id/sub|dub/:ep
```
302 redirect directly to the HLS stream.

<a id="reanime-flixcloud-playback"></a>
## ReAnime / FlixCloud playback notes

<details>
<summary>Click to see playback/decryption guide</summary>

ReAnime uses FlixCloud for some streams. The returned `url` can be a signed HLS master URL, but FlixCloud may return the manifest as a Base64 + XOR payload instead of plaintext `#EXTM3U`.

For those streams, use the returned `playlist_key` or `key` field to decode the master playlist and any child playlists before handing them to an HLS player.

```js
function decryptFlixManifest(bodyBuffer, playlistKey) {
  const raw = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer);
  const trimmed = raw.toString("utf8").trim();

  if (trimmed.startsWith("#EXTM3U")) return trimmed;

  const key = Buffer.from(playlistKey, "base64");
  let payload = Buffer.from(trimmed, "base64");
  const out = Buffer.alloc(payload.length);

  for (let i = 0; i < payload.length; i++) {
    out[i] = payload[i] ^ key[i % key.length];
  }

  const text = out.toString("utf8").trim();
  if (!text.startsWith("#EXTM3U")) throw new Error("FlixCloud manifest decrypt failed");
  return text;
}

function getManifestUrls(m3u8Text) {
  return m3u8Text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function fetchAndDecryptFlixManifest(manifestUrl, playlistKey) {
  const res = await fetch(manifestUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://flixcloud.cc/",
      "Origin": "https://flixcloud.cc"
    }
  });

  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);

  const body = Buffer.from(await res.arrayBuffer());
  return decryptFlixManifest(body, playlistKey);
}
```

`HD-1` commonly uses AES-keyed HLS playlists. `HD-2` commonly uses image-wrapped `.png`/`.webp` segment URLs, so a custom proxy/player may need to unwrap those segment bytes before playback.

For HD-2 style image-wrapped segments, fetch the segment through your proxy, unwrap it, and return it as `video/mp2t`.

```js
const flixImageSegmentXorKey = Uint8Array.from([
  157, 42, 241, 71, 179, 142, 92, 112,
  166, 25, 228, 59, 216, 98, 15, 197
]);

function unwrapFlixImageSegment(bodyBuffer) {
  const body = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer);
  let offset = 0;
  let needsXor = false;

  const isWebp =
    body.length > 12 &&
    body[0] === 0x52 &&
    body[1] === 0x49 &&
    body[2] === 0x46 &&
    body[3] === 0x46 &&
    body[8] === 0x57 &&
    body[9] === 0x45 &&
    body[10] === 0x42 &&
    body[11] === 0x50;

  const isPng =
    body.length > 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47 &&
    body[4] === 0x0d &&
    body[5] === 0x0a &&
    body[6] === 0x1a &&
    body[7] === 0x0a;

  if (isWebp) {
    offset = 12;
    needsXor = body[offset] !== 0x47;
  } else if (isPng) {
    offset = 8;
    needsXor = body[offset] !== 0x47;
  }

  if (!offset) return { body, unwrapped: false };

  const out = Buffer.from(body.subarray(offset));
  if (needsXor) {
    for (let i = 0; i < out.length; i++) {
      out[i] ^= flixImageSegmentXorKey[i % flixImageSegmentXorKey.length];
    }
  }

  return { body: out, unwrapped: true };
}
```

The API does not expose a public ReAnime `/proxy` route. If you need direct custom-player playback, use the returned `embed` URL or implement the manifest decode/proxy flow above.

***Removed the ReAnime `/proxy` endpoint since it was unnecessary and did not handle the Flixcloud playback flow anyway.***

</details>

---

## Self-hosted

```bash
git clone https://github.com/walterwhite-69/Anivexa-API
cd Anivexa-API
npm install
cp .env.example .env
node server.js
```

Runs on Node.js. No build step needed.

### Environment variables

Copy `.env.example` to `.env` and fill in the values.

| Variable | Default | Notes |
|---|---|---|
| `CACHE_ENABLED` | `false` | Set to `true` to enable caching (memory + disk + Redis). |
| `UPSTASH_REDIS_REST_URL` | — | From [upstash.com](https://upstash.com). Only used when `CACHE_ENABLED=true`. |
| `UPSTASH_REDIS_REST_TOKEN` | — | From [upstash.com](https://upstash.com). Only used when `CACHE_ENABLED=true`. |
| `DEFAULT_REDIS_TTL` | `900` | Seconds. Fallback expiry for Redis writes when a per-item TTL isn't computed. Most cache entries use their own smart TTLs based on anime status (finished/airing/etc.) — this is just the safety-net default. |
| `PORT` | `4000` | Local dev server port (`server.js` only — ignored on Vercel/serverless). Change it if `4000` is already in use, then hit `http://localhost:PORT`. |
On Vercel (or Railway/Render), set these as regular project environment variables instead of committing `.env`.

---

## Deploying on Vercel

> ⚠️ **Not recommended.** Vercel runs on shared datacenter IPs that are widely blocked by anime streaming sites. Most providers will fail silently or return errors — the API will technically run but you'll get little to no data back. Use a self-hosted VPS or use railway, render etc etc.

---

## Contributing

> **Only request providers that self-host their content. No scrapers of third-party sites.**

Got a provider you'd like added? Open an issue.

This project is community-kept-alive — if it helps you, please:

- ⭐ **Star the repo** so others can find it
- 🛠️ **Open a PR** if you want to add or fix something

---

<div align="center">

hope it helped :3

</div>
