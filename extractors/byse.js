import { webcrypto as crypto } from "node:crypto";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const BLOCKS = 512;
const MASK = BLOCKS - 1;
const ROUNDS = 2;
const MUL_A = 2654435761;
const MUL_B = 2246822519;

function base64UrlEncode(input) {
  // Accept ArrayBuffer/Uint8Array or Buffer
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

function base64UrlDecode(str) {
  return Buffer.from(String(str), "base64url");
}

function rot(value, shift) {
  return (value << shift | value >>> (32 - shift)) >>> 0;
}

function mul(value, factor) {
  return Math.imul(value, factor) >>> 0;
}

function mix(state) {
  state[0] = (state[0] + state[1]) >>> 0;
  state[3] = rot(state[3] ^ state[0], 16);
  state[2] = (state[2] + state[3]) >>> 0;
  state[1] = rot(state[1] ^ state[2], 12);
  state[0] = (state[0] + state[1]) >>> 0;
  state[3] = rot(state[3] ^ state[0], 8);
  state[2] = (state[2] + state[3]) >>> 0;
  state[1] = rot(state[1] ^ state[2], 7);
}

function hash(bytes) {
  // Accept Buffer/Uint8Array
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const state = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (let i = 0; i < input.length; i++) {
    state[0] = (state[0] + input[i]) >>> 0;
    state[0] = rot(state[0], 7);
    mix(state);
  }
  for (let i = 0; i < 8; i++) mix(state);
  const table = new Uint32Array(BLOCKS);
  for (let i = 0; i < BLOCKS; i++) {
    mix(state);
    table[i] = (state[0] ^ state[2]) >>> 0;
  }
  for (let i = 0; i < ROUNDS; i++) {
    for (let index = 0; index < BLOCKS; index++) {
      const tableIndex = table[index] & MASK;
      let value = (table[index] + table[tableIndex]) >>> 0;
      value = rot(value, 13);
      value = (value ^ mul(table[(index + 1) & MASK], MUL_A)) >>> 0;
      table[index] = value;
      state[0] = (state[0] ^ value) >>> 0;
      mix(state);
    }
  }
  const out = new Uint32Array(8);
  const width = BLOCKS / 8;
  for (let i = 0; i < 8; i++) {
    mix(state);
    let value = state[0];
    const offset = i * width;
    for (let index = 0; index < width; index++) {
      const tableValue = table[offset + index];
      value = (value + tableValue) >>> 0;
      value = rot(value, 5);
      value = (value ^ mul(tableValue, MUL_B)) >>> 0;
    }
    out[i] = (value ^ state[2]) >>> 0;
  }
  return out;
}

function latin1Bytes(value) {
  // Use Buffer's latin1 encoding which matches original charCode & 0xff behavior
  return Buffer.from(String(value), "latin1");
}

function leadingZeros(value) {
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (item === 0) {
      total += 32;
      continue;
    }
    return total + Math.clz32(item);
  }
  return total;
}

/**
 * Solve the provided PoW in a non-blocking way.
 * Returns a string solution (counter) when found.
 * Options:
 *  - yieldPeriod: how many iterations to run before yielding to the event loop (default 1000)
 *  - maxIterations: optional safety limit to avoid infinite loop
 */
async function solvePoW(nonce, difficulty, { yieldPeriod = 1000, maxIterations = Number.MAX_SAFE_INTEGER } = {}) {
  const prefix = `${nonce}:`;
  let counter = 0;
  // Run loop and occasionally yield so Node's event loop isn't starved
  while (counter < maxIterations) {
    const bytes = latin1Bytes(prefix + counter);
    if (leadingZeros(hash(bytes)) >= difficulty) return String(counter);
    counter++;
    if ((counter & (yieldPeriod - 1)) === 0) {
      // yield to event loop
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  throw new Error("PoW solution not found within maxIterations");
}

export function canExtractByse(url) {
  return /(?:bysesayeveum\.com|gn1r5n\.org)\/e\//i.test(String(url));
}

export async function extractByse(embedUrl, { fetchImpl = fetch, userAgent = DEFAULT_USER_AGENT, referer, signal } = {}) {
  if (!embedUrl) throw new TypeError("embedUrl is required");
  const code = String(embedUrl).match(/\/e\/([a-z0-9]+)/i)?.[1];
  if (!code) throw new Error(`Cannot extract Byse code from ${embedUrl}`);

  const embedOrigin = new URL(embedUrl).origin;
  const parentUrl = referer || embedUrl;
  const parentHost = new URL(parentUrl).hostname;

  const embedHeaders = {
    "X-Embed-Origin": parentHost,
    "X-Embed-Referer": parentUrl,
    "X-Embed-Parent": embedUrl,
  };

  const commonFetch = async (url, opts = {}) => {
    const headers = Object.assign({
      "User-Agent": userAgent,
      "Accept": "application/json",
      "Referer": embedUrl,
    }, opts.headers || {});
    const res = await fetchImpl(url, { signal, ...opts, headers });
    return res;
  };

  // details
  const detailsResponse = await commonFetch(`${embedOrigin}/api/videos/${code}/embed/details`, {});
  if (!detailsResponse.ok) throw new Error(`Byse details HTTP ${detailsResponse.status}`);
  const details = await detailsResponse.json();

  const frameUrl = details.embed_frame_url || embedUrl;
  const frameBase = new URL(frameUrl).origin;

  // challenge
  const challengeResponse = await commonFetch(`${frameBase}/api/videos/access/challenge`, {
    method: "POST",
    headers: { "Content-Length": "0", "Origin": frameBase },
    body: null,
  });
  if (!challengeResponse.ok) throw new Error(`Byse challenge HTTP ${challengeResponse.status}`);
  const challenge = await challengeResponse.json();

  // generate ECDSA keypair and sign challenge nonce
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const signatureBuf = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(challenge.nonce));

  // attest
  const attestResponse = await commonFetch(`${frameBase}/api/videos/access/attest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase },
    body: JSON.stringify({ nonce: challenge.nonce, challenge_id: challenge.challenge_id, public_key: publicKey, signature: base64UrlEncode(signatureBuf) })
  });
  if (!attestResponse.ok) throw new Error(`Byse attest HTTP ${attestResponse.status}`);
  const attest = await attestResponse.json();

  // cookies / fingerprint
  const cookie = `byse_viewer_id=${attest.viewer_id}; byse_device_id=${attest.device_id}`;
  const fingerprint = { token: attest.token, viewer_id: attest.viewer_id, device_id: attest.device_id, confidence: attest.confidence };

  // captcha
  const captchaResponse = await commonFetch(`${frameBase}/api/videos/${code}/embed/captcha`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Cookie": cookie, ...embedHeaders },
    body: JSON.stringify({ fingerprint })
  });
  if (!captchaResponse.ok) throw new Error(`Byse captcha HTTP ${captchaResponse.status}`);
  const captcha = await captchaResponse.json();

  // solve PoW (async, yields periodically)
  const solution = await solvePoW(captcha.pow_nonce, captcha.pow_difficulty, { yieldPeriod: 2048, maxIterations: 10_000_000 });

  const verifyResponse = await commonFetch(`${frameBase}/api/videos/${code}/embed/captcha/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Cookie": cookie, ...embedHeaders },
    body: JSON.stringify({ pow_token: captcha.pow_token, solution, fingerprint })
  });
  if (!verifyResponse.ok) throw new Error(`Byse verify HTTP ${verifyResponse.status}`);
  const verification = await verifyResponse.json();

  // playback
  const playbackResponse = await commonFetch(`${frameBase}/api/videos/${code}/embed/playback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Cookie": cookie, "X-Captcha-Token": verification.token, ...embedHeaders },
    body: JSON.stringify({ fingerprint })
  });
  if (!playbackResponse.ok) throw new Error(`Byse playback HTTP ${playbackResponse.status}`);
  const playbackData = await playbackResponse.json();
  const playback = playbackData.playback;

  // assemble AES key from key parts (only 16-byte parts)
  const parts = playback.key_parts || [];
  const keyBuffers = parts.map(String).filter((item) => base64UrlDecode(item).length === 16).map(base64UrlDecode);
  if (keyBuffers.length === 0) throw new Error("No valid AES key parts found in playback response");
  const keyBytes = Buffer.concat(keyBuffers);

  // import AES-GCM key and decrypt payload
  const aesKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  let decrypted;
  try {
    decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlDecode(playback.iv) }, aesKey, base64UrlDecode(playback.payload));
  } catch (err) {
    throw new Error(`Failed to decrypt playback payload: ${err?.message || err}`);
  }

  const decoded = new TextDecoder("utf-8").decode(decrypted);
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (err) {
    throw new Error(`Failed to parse decrypted playback JSON: ${err?.message || err}`);
  }

  const sources = Array.isArray(parsed.sources) ? parsed.sources.map((s) => s.url).filter(Boolean) : [];
  return sources;
}
