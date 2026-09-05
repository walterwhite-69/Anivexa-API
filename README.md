<div align="center">


<img src="docs/logo.svg" width="80" height="80"/>


# Anivexa API 2.2.1

**Anime streaming aggregator API — one endpoint, all your sources.**

![Views](https://visitor-badge.laobi.icu/badge?page_id=walterwhite-69.Anivexa-API)
[![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/MARQ9z9QSX)
[![GitHub stars](https://img.shields.io/github/stars/walterwhite-69/Anivexa-API?style=flat-square&color=yellow)](https://github.com/walterwhite-69/Anivexa-API/stargazers)

</div>

---

## What is this?

A single API that aggregates anime episode lists and streaming links from multiple providers. Give it an AniList ID, get back everything — episodes, sources, and stream URLs — all in one place.

It's the backbone powering **[Anivexa](https://github.com/walterwhite-69/Anivexa)**, a full anime streaming client built on top of this.

---

## Providers

| Provider | Status | Notes |
|---|---|---|
| **MKissa** | ✅ Active | Large Library, Note: it may still return 403 error, their backend is one of the trickiest, it works fine but sometimes return "Need Captcha" Error. It might be slow since it will retry if it gets captcha error while requesting|
| **Reanime** | ✅ Active | Solid source for a wide range of titles |
| **AniKoto** | ✅ Active | Good library, consistent |
| **AnimeGG** | ✅ Active | Fuzzy title matching + compact-query fix for sequels (e.g. Re:Zero S4) |
| **AniNeko** | ✅ Active | Reliable slug-based matching |
| **AniDB App** | ✅ Active | Language-aware, AniDB ID backed |
| **AniZone** | ✅ Active | HLS + subtitles, sub-only; year-based re-scoring prevents wrong-season matches |
| **AniWaves** | ✅ Active | Direct HLS from Vidplay, MyCloud, and BYFMS; DATASV quality MP4 sources; embed fallbacks |
| **2dhive** | ✅ Active | Uses MAL ID internally; AniList ID used everywhere else |
| **Anibd** | ✅ Active | Uses Anilist ID internally; AniList ID used everywhere else |
| **Kickassanime** | ✅ Active | Fuzzy search, medium library |
| **AnimeDunya** | ✅ Active | HLS + subtitles, sub-only, MAL ID backed |

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
Returns episode lists in a single response with smart background refresh. Pass one or more provider names in the path to filter results — e.g. `/episodes/anizone/mkissa/16498` returns only those two. Omit providers to get all of them.

```
GET /watch/:provider/:anilistId/sub|dub/:provider-:ep
```
Returns stream URLs for a specific episode from a specific provider.

```
GET /stream/reanime/:id/sub|dub/:ep
```
302 redirect directly to the HLS stream.

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

> ⚠️ **Not recommended.** Vercel runs on shared datacenter IPs that are widely blocked by anime streaming sites. Most providers will fail silently or return errors — the API will technically run but you'll get little to no data back. Use a self-hosted VPS or use railway, render etc etc. The proxy file is for anidb app not for streams!

---

## Contributing

> **Only request providers that self-host their content. No scrapers of third-party sites.**

Got a provider you'd like added? Open an issue or drop it in the Discord.

This project is community-kept-alive — if it helps you, please:

- ⭐ **Star the repo** so others can find it
- 💬 **[Join the Discord](https://discord.gg/MARQ9z9QSX)** to discuss, report issues, or suggest providers
- 🛠️ **Open a PR** if you want to add or fix something

---

<div align="center">

hope it helped :3

[![Discord](https://img.shields.io/badge/Join%20the%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/MARQ9z9QSX)

</div>
