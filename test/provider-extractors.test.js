import assert from "node:assert/strict";
import { createCipheriv, webcrypto } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { extractByse } from "../extractors/byse.js";
import { extractFlixcloud } from "../extractors/flixcloud.js";
import { extractMegaPlayDetails } from "../extractors/megaplay.js";
import { extractNova } from "../extractors/nova.js";
import { decodePayload } from "../extractors/voe.js";
import { findVideoExtractor } from "../extractors/index.js";

const EXPECTED_PROVIDERS = [
  "anihq", "reanime", "anikoto", "animegg", "animenosub", "anizone",
  "aniwaves", "pahenime", "kaa", "animedunya", "animeonsen", "anipm",
];

const PROVIDER_FILES = {
  anihq: "anihq.js",
  reanime: "reanime.js",
  anikoto: "anikoto.js",
  animegg: "animegg.js",
  animenosub: "animenosub.js",
  anizone: "anizone.js",
  aniwaves: "aniwaves.js",
  pahenime: "pahenime.js",
  kaa: "kickassanime.js",
  animedunya: "animedunya.js",
  animeonsen: "animeonsen.js",
  anipm: "anipm.js",
};

const EXTRACTOR_FIXTURES = [
  ["byse", "https://bysesayeveum.com/e/health-fixture"],
  ["datasv", "https://play.echovideo.ru/embed-20/health-fixture"],
  ["megaplay", "https://megaplay.example/stream/health-fixture"],
  ["vidplay", "https://play.echovideo.ru/embed-1/health-fixture"],
  ["vidmoly", "https://vidmoly.net/health-fixture"],
  ["voe", "https://voe.sx/e/health-fixture"],
  ["nova", "https://upn.one/#health-fixture"],
];

const EXTRACTOR_FILES = [
  "byse.js", "datasv.js", "flixcloud.js", "megaplay.js",
  "nova.js", "vidmoly.js", "vidplay.js", "voe.js",
];

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function base64(value) {
  return Buffer.from(value).toString("base64");
}

async function sha256hex(value) {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}

async function flixFields(seed) {
  let first = seed;
  for (let index = 0; index < 3; index++) first = await sha256hex(`${first}${index}`);
  let second = first;
  for (let index = 0; index < 3; index++) second = await sha256hex(`${second}${index}`);
  return {
    keyField: `kf_${first.substring(8, 16)}`,
    ivField: `ivf_${first.substring(16, 24)}`,
    containerName: `cd_${first.substring(24, 32)}`,
    arrayName: `ad_${first.substring(32, 40)}`,
    objectName: `od_${first.substring(40, 48)}`,
    tokenField: `${first.substring(48, 64)}_${first.substring(56, 64)}`,
    keyFrag2Field: `${second.substring(0, 16)}_${second.substring(16, 24)}`,
  };
}

function leb(value) {
  const output = [];
  do {
    let byte = value & 127;
    value >>>= 7;
    if (value) byte |= 128;
    output.push(byte);
  } while (value);
  return output;
}

function wasmSection(id, payload) {
  return [id, ...leb(payload.length), ...payload];
}

function makeFlixWasm() {
  const segment = Uint8Array.from({ length: 64 }, (_, index) => index);
  const dataEntry = [0, 65, 0, 11, ...leb(segment.length), ...segment];
  const data = wasmSection(11, [1, ...dataEntry]);
  const xorEnd = [32, 2, 32, 5, 106, 45, 0, 0, 115, 33, 6];
  const body = [0, ...xorEnd, 32, 6, 33, 6, 32, 5, 65, 0, 108];
  const code = wasmSection(10, [2, 1, 0, ...leb(body.length), ...body]);
  return { wasm: Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, ...data, ...code]), segment };
}

test("the API provider list matches the provider modules", async () => {
  const { default: worker } = await import("../index.js");
  const response = await worker.fetch(new Request("https://anivexa.local/"), { API_VERSION: "2.3" });
  const registry = await response.json();
  const providerFiles = readdirSync(new URL("../providers/", import.meta.url)).filter((file) => file.endsWith(".js"));
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const documentedNames = [...readme.matchAll(/^\| .+ \| `([a-z]+)` \|$/gm)].map((match) => match[1]);

  assert.deepEqual(registry.providers, EXPECTED_PROVIDERS);
  assert.deepEqual(Object.keys(PROVIDER_FILES), EXPECTED_PROVIDERS);
  assert.deepEqual([...providerFiles].sort(), Object.values(PROVIDER_FILES).sort());
  assert.deepEqual(documentedNames, EXPECTED_PROVIDERS);

  const extractorFiles = readdirSync(new URL("../extractors/", import.meta.url))
    .filter((file) => file.endsWith(".js") && file !== "index.js");
  const documentedExtractors = [...readme.matchAll(/^\| ([^|]+) \| (.+) \|$/gm)]
    .map((match) => match[1].trim())
    .filter((name) => ["Byse", "DataSV", "FlixCloud", "MegaPlay", "Nova", "Vidmoly", "Vidplay", "VOE"].includes(name));

  assert.deepEqual([...extractorFiles].sort(), EXTRACTOR_FILES.sort());
  assert.deepEqual(documentedExtractors, ["Byse", "DataSV", "FlixCloud", "MegaPlay", "Nova", "Vidmoly", "Vidplay", "VOE"]);
});

test("every registered video extractor matches its representative URL", () => {
  for (const [name, url] of EXTRACTOR_FIXTURES) {
    assert.equal(findVideoExtractor(url)?.name, name, `${name} should match ${url}`);
  }
  assert.equal(findVideoExtractor("https://unknown.example/embed/health-fixture"), null);
});

test("Nova decrypts an AES-128-CBC source using its configured key and IV", async () => {
  const key = Buffer.from("6b69656d7469656e6d75613931316361", "hex");
  const iv = Buffer.from("313233343536373839306f6975797472", "hex");
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ source: "https://media.example/fixture.m3u8" })),
    cipher.final(),
  ]);

  const result = await extractNova("https://upn.one/#health-fixture", {
    fetchImpl: async () => new Response(encrypted.toString("hex")),
  });

  assert.deepEqual(result, ["https://media.example/fixture.m3u8"]);
});

test("MegaPlay decrypts an AES-CBC source using keys discovered in its script", async () => {
  const textKey = "health-test-key";
  const key = Buffer.alloc(32);
  Buffer.from(textKey).copy(key);
  const iv = Buffer.from("0123456789abcdef");
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ file: "https://media.example/megaplay.m3u8" })),
    cipher.final(),
  ]);
  const script = `const legacy = "stream/getSources"; const modern = "stream/getSourcesV2"; const key = "${textKey}"; const iv = "${iv.toString()}"; const cipher = "AES-CBC";`;

  const result = await extractMegaPlayDetails("https://megaplay.example/stream/health-fixture", {
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/stream/health-fixture") {
        return new Response('<div data-id="fixture"></div><script src="/player.js"></script>');
      }
      if (url.pathname === "/player.js") return new Response(script);
      if (url.pathname.startsWith("/stream/getSources")) return jsonResponse({ enc: base64url(encrypted) });
      return new Response("Not found", { status: 404 });
    },
  });

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, "https://media.example/megaplay.m3u8");
});

test("Byse verifies a challenge and decrypts its AES-GCM playback payload", async () => {
  const aesKey = Buffer.from("00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100", "hex");
  const iv = Buffer.from("aabbccddeeff001122334455", "hex");
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ sources: [{ url: "https://media.example/byse.m3u8" }] })),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const fetchImpl = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/embed/details")) return jsonResponse({ embed_frame_url: "https://frame.example/e/health-fixture" });
    if (pathname.endsWith("/access/challenge")) return jsonResponse({ nonce: "fixture-nonce", challenge_id: "fixture-challenge" });
    if (pathname.endsWith("/access/attest")) return jsonResponse({ viewer_id: "viewer", device_id: "device", token: "attest", confidence: 1 });
    if (pathname.endsWith("/embed/captcha")) return jsonResponse({ pow_token: "pow", pow_nonce: "nonce", pow_difficulty: 0 });
    if (pathname.endsWith("/embed/captcha/verify")) return jsonResponse({ token: "verified" });
    if (pathname.endsWith("/embed/playback")) {
      return jsonResponse({ playback: {
        key_parts: [base64url(aesKey.subarray(0, 16)), base64url(aesKey.subarray(16))],
        iv: base64url(iv),
        payload: base64url(ciphertext),
      } });
    }
    return new Response("Not found", { status: 404 });
  };

  const result = await extractByse("https://bysesayeveum.com/e/health-fixture", { fetchImpl });
  assert.deepEqual(result, ["https://media.example/byse.m3u8"]);
});

test("FlixCloud derives the playlist key and decrypts its AES-CBC payload", async () => {
  const seed = "00000000";
  const token = "health-token";
  const iv = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const fragment = Buffer.alloc(32);
  const keyFragment = Buffer.alloc(32);
  const { wasm, segment } = makeFlixWasm();
  const material = await webcrypto.subtle.importKey("raw", fragment, { name: "PBKDF2" }, false, ["deriveBits"]);
  const derived = new Uint8Array(await webcrypto.subtle.deriveBits({
    name: "PBKDF2", salt: new TextEncoder().encode(seed), iterations: 1000, hash: "SHA-256",
  }, material, 256));
  for (let index = 0; index < derived.length; index++) derived[index] ^= seed.charCodeAt(index % seed.length);
  const aesKeyBytes = new Uint8Array(await webcrypto.subtle.digest("SHA-256", derived));
  const aesKey = await webcrypto.subtle.importKey("raw", aesKeyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
  const videoBytes = await webcrypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    aesKey,
    new TextEncoder().encode("https://media.example/flixcloud.m3u8"),
  );
  const fields = await flixFields(seed);
  const object = { [fields.keyField]: base64(fragment), [fields.ivField]: base64(iv) };
  const data = {
    obfuscation_seed: seed,
    obfuscated_crypto_data: {
      [fields.containerName]: { [fields.arrayName]: [{ [fields.objectName]: object }] },
    },
    [fields.keyFrag2Field]: base64(keyFragment),
    [fields.tokenField]: token,
    w_payload: base64(wasm),
  };
  const embedHtml = `<script>window.payload={type:"data",data:${JSON.stringify(data)}}</script>`;
  const tokenData = {
    [(await sha256hex(`${token}vid`)).substring(0, 10)]: base64(videoBytes),
    [(await sha256hex(`${token}key`)).substring(0, 10)]: base64(Buffer.alloc(32)),
  };

  const result = await extractFlixcloud(embedHtml, {
    apiBase: "https://fixture.flixcloud",
    fetchImpl: async (input) => new URL(String(input)).pathname === `/api/m3u8/${token}`
      ? jsonResponse(tokenData)
      : new Response("Not found", { status: 404 }),
  });

  const expectedKey = Buffer.from(segment.subarray(0, 32).map((value, index) => value ^ segment[index + 32])).toString("base64");
  assert.equal(result.url, "https://media.example/flixcloud.m3u8");
  assert.equal(result.playlist_key, expectedKey);
  assert.equal(result.key, result.playlist_key);
});

test("VOE decodes its layered source payload", () => {
  const config = { source: "https://media.example/voe.m3u8", title: "Fixture" };
  const first = Buffer.from(JSON.stringify(config)).toString("base64").split("").reverse().join("");
  const shifted = [...first].map((character) => String.fromCharCode(character.charCodeAt(0) + 3)).join("");
  const second = Buffer.from(shifted, "binary").toString("base64");
  const encoded = second.replace(/[a-zA-Z]/g, (character) => {
    const base = character <= "Z" ? 65 : 97;
    return String.fromCharCode(((character.charCodeAt(0) - base + 13) % 26) + base);
  });

  assert.deepEqual(decodePayload(encoded), config);
});
