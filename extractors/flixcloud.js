import { webcrypto as crypto } from "node:crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * SHA-256 digest returned as hex string
 */
async function sha256hex(value) {
  const data = typeof value === "string" ? encoder.encode(value) : value;
  const bytes = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Base64 -> Uint8Array. Uses atob when available, otherwise Node's Buffer.
 */
function b64toU8(value) {
  if (!value) return new Uint8Array(0);
  // Prefer global atob in browser-like environments
  if (typeof atob === "function") {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  // Node.js fallback
  return Uint8Array.from(Buffer.from(value, "base64"));
}

/**
 * Derive obfuscated field names from seed.
 */
async function deriveFields(seed) {
  let first = seed;
  for (let i = 0; i < 3; i++) first = await sha256hex(first + i);
  let second = first;
  for (let i = 0; i < 3; i++) second = await sha256hex(second + i);
  return {
    keyField: "kf_" + first.substring(8, 16),
    ivField: "ivf_" + first.substring(16, 24),
    containerName: "cd_" + first.substring(24, 32),
    arrayName: "ad_" + first.substring(32, 40),
    objectName: "od_" + first.substring(40, 48),
    tokenField: first.substring(48, 64) + "_" + first.substring(56, 64),
    keyFrag2Field: second.substring(0, 16) + "_" + second.substring(16, 24)
  };
}

/**
 * Find the SSR data object in embed HTML. Returns the JS object literal substring.
 */
function extractSsrObj(html) {
  const match = html.match(/\{\s*type\s*:\s*"data"\s*,\s*data\s*:\s*(\{)/);
  if (!match) throw Object.assign(new Error("SSR data block not found"), { code: "NO_SSR" });
  let depth = 0;
  const start = html.indexOf("{", match.index + match[0].length - 1);
  if (start < 0) throw Object.assign(new Error("SSR start brace not found"), { code: "NO_START" });
  for (let i = start; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw Object.assign(new Error("SSR brace matching failed"), { code: "NO_MATCH" });
}

/**
 * Minimal JS literal parser used to parse the embedded SSR object. Intentionally small and
 * tolerant of a few non-standard tokens used in some bundles (undefined, !0, !1).
 */
function parseJsLiteral(source) {
  let index = 0;
  function whitespace() {
    while (index < source.length && /\s/.test(source[index])) index++;
  }
  function doubleString() {
    let out = "";
    index++; // skip opening quote
    while (index < source.length && source[index] !== '"') {
      if (source[index] === "\\") {
        index++;
        const ch = source[index];
        out += ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" }[ch] ?? ch);
        index++;
      } else out += source[index++];
    }
    index++; // skip closing quote
    return out;
  }
  function singleString() {
    let out = "";
    index++;
    while (index < source.length && source[index] !== "'") {
      if (source[index] === "\\") {
        index++;
        const ch = source[index];
        out += (ch === "'" ? "'" : ({ n: "\n", t: "\t", r: "\r", "\\": "\\" }[ch] ?? ch));
        index++;
      } else out += source[index++];
    }
    index++;
    return out;
  }
  function key() {
    whitespace();
    if (source[index] === '"') return doubleString();
    if (source[index] === "'") return singleString();
    const match = source.slice(index).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
    if (!match) throw new Error(`Bad key at pos ${index}: ${source.slice(index, index + 20)}`);
    index += match[0].length;
    return match[0];
  }
  function object() {
    const out = {};
    index++; // skip {
    whitespace();
    while (index < source.length && source[index] !== "}") {
      if (source[index] === ",") {
        index++;
        whitespace();
        continue;
      }
      const property = key();
      whitespace();
      if (source[index] !== ":") throw new Error(`Expected : after key at ${index}`);
      index++; // skip :
      out[property] = value();
      whitespace();
    }
    index++; // skip }
    return out;
  }
  function array() {
    const out = [];
    index++; // skip [
    whitespace();
    while (index < source.length && source[index] !== "]") {
      if (source[index] === ",") {
        index++;
        whitespace();
        continue;
      }
      out.push(value());
      whitespace();
    }
    index++; // skip ]
    return out;
  }
  function value() {
    whitespace();
    if (source[index] === "{") return object();
    if (source[index] === "[") return array();
    if (source[index] === '"') return doubleString();
    if (source[index] === "'") return singleString();
    if (source.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (source.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (source.startsWith("null", index)) {
      index += 4;
      return null;
    }
    if (source.startsWith("undefined", index)) {
      index += 9;
      return null;
    }
    // Some minifiers use !0 / !1 for true/false
    if (source.startsWith("!0", index)) {
      index += 2;
      return true;
    }
    if (source.startsWith("!1", index)) {
      index += 2;
      return false;
    }
    const numMatch = source.slice(index).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numMatch) {
      index += numMatch[0].length;
      return parseFloat(numMatch[0]);
    }
    throw new Error(`JS parse error at pos ${index}: ...${source.slice(index, index + 20)}`);
  }
  return value();
}

/**
 * Parse the custom WASM-based transform from a payload. Returns {step, transform}
 */
function parseWasmDecrypt(bytes) {
  let position = 8; // skip wasm header
  while (position < bytes.length) {
    const section = bytes[position++];
    let size = 0;
    let shift = 0;
    let next;
    do {
      next = bytes[position++];
      size |= (next & 127) << shift;
      shift += 7;
    } while (next & 128);
    if (section === 10) {
      // code section: skip body
      position++;
      let bodySize = 0;
      let bodyShift = 0;
      do {
        next = bytes[position++];
        bodySize |= (next & 127) << bodyShift;
        bodyShift += 7;
      } while (next & 128);
      position += bodySize;
      break;
    }
    position += size;
  }
  let functionSize = 0;
  let functionShift = 0;
  let next;
  do {
    next = bytes[position++];
    functionSize |= (next & 127) << functionShift;
    functionShift += 7;
  } while (next & 128);
  const body = bytes.slice(position, position + functionSize);

  function leb(array, index) {
    let value = 0;
    let shift = 0;
    let next;
    do {
      next = array[index++];
      value |= (next & 127) << shift;
      shift += 7;
    } while (next & 128);
    return [value, index];
  }

  const xorEnd = [32, 2, 32, 5, 106, 45, 0, 0, 115, 33, 6];
  let transformStart = -1;
  outer: for (let i = 0; i < body.length - xorEnd.length; i++) {
    for (let j = 0; j < xorEnd.length; j++) if (body[i + j] !== xorEnd[j]) continue outer;
    transformStart = i + xorEnd.length;
    break;
  }
  if (transformStart < 0) throw new Error("WASM: transform start not found");

  let transformEnd = -1;
  let step = 36;
  for (let i = transformStart; i < body.length - 4; i++) {
    if (body[i] === 32 && body[i + 1] === 5 && body[i + 2] === 65) {
      const [value, nextIndex] = leb(body, i + 3);
      if (body[nextIndex] === 108) {
        transformEnd = i;
        step = value;
        break;
      }
    }
  }
  if (transformEnd < 0) throw new Error("WASM: keystream not found");
  const code = body.slice(transformStart, transformEnd);

  function transform(inputByte) {
    let local = inputByte & 255;
    const stack = [];
    let idx = 0;
    while (idx < code.length) {
      const opcode = code[idx++];
      if (opcode === 32) {
        const [localIndex, nextIndex] = leb(code, idx);
        idx = nextIndex;
        stack.push(localIndex === 6 ? local : 0);
      } else if (opcode === 33) {
        const [localIndex, nextIndex] = leb(code, idx);
        idx = nextIndex;
        const value = stack.pop();
        if (localIndex === 6) local = value & 255;
      } else if (opcode === 65) {
        const [value, nextIndex] = leb(code, idx);
        idx = nextIndex;
        stack.push(value);
      } else if (opcode === 106) {
        const right = stack.pop();
        const left = stack.pop();
        stack.push((left + right) & 255);
      } else if (opcode === 107) {
        const right = stack.pop();
        const left = stack.pop();
        stack.push((left - right + 256) & 255);
      } else if (opcode === 113) {
        const right = stack.pop();
        const left = stack.pop();
        stack.push((left & right) & 255);
      } else if (opcode === 114) {
        const right = stack.pop();
        const left = stack.pop();
        stack.push((left | right) & 255);
      } else if (opcode === 115) {
        const right = stack.pop();
        const left = stack.pop();
        stack.push((left ^ right) & 255);
      } else if (opcode === 116) {
        const right = stack.pop();
        const left = stack.pop();
        stack.push((left << (right & 7)) & 255);
      } else if (opcode === 118) {
        const right = stack.pop();
        const left = stack.pop();
        stack.push((left >>> (right & 7)) & 255);
      } else {
        // Unknown opcode: best-effort skip (not expected)
      }
    }
    return local;
  }
  return { step, transform };
}

/**
 * Run the WASM-based decrypt transformation. This function guards against shorter
 * key/token fragments by wrapping indices.
 */
function runDecrypt(wasmBytes, fragment, keyFragment, token, seed) {
  const { step, transform } = parseWasmDecrypt(wasmBytes);
  const out = new Uint8Array(fragment.length);
  for (let i = 0; i < fragment.length; i++) {
    const k = keyFragment.length ? keyFragment[i % keyFragment.length] : 0;
    const t = token.length ? token[i % token.length] : 0;
    // make operator precedence explicit and clamp to a byte
    const value = (fragment[i] ^ k ^ (t & 255)) & 255;
    out[i] = (((transform(value) ^ (i * step)) + seed) & 255) >>> 0;
  }
  return out;
}

/**
 * Main extractor. fetchImpl can be overridden for testing.
 */
export async function extractFlixcloud(embedHtml, { fetchImpl = fetch, apiBase = "https://flixcloud.cc", headers = {}, referer } = {}) {
  const data = parseJsLiteral(extractSsrObj(embedHtml));

  const seed = data?.obfuscation_seed;
  if (!seed) {
    const error = new Error("obfuscation_seed missing");
    error.debug = { topKeys: Object.keys(data ?? {}).slice(0, 20) };
    throw error;
  }

  const fields = await deriveFields(seed);

  const cryptoData = data?.obfuscated_crypto_data;
  if (!cryptoData) {
    const error = new Error("obfuscated_crypto_data missing");
    error.debug = { fields, topKeys: Object.keys(data).slice(0, 20) };
    throw error;
  }

  const container = cryptoData[fields.containerName];
  if (!container) {
    const error = new Error(`containerName "${fields.containerName}" not in ocd`);
    error.debug = { fields, ocdKeys: Object.keys(cryptoData).slice(0, 10) };
    throw error;
  }

  const array = container[fields.arrayName];
  if (!Array.isArray(array) || array.length === 0) {
    const error = new Error(`arrayName "${fields.arrayName}" not present or empty`);
    error.debug = { fields, containerKeys: Object.keys(container).slice(0, 10) };
    throw error;
  }

  const object = array[0][fields.objectName];
  if (!object || typeof object !== "object") {
    const error = new Error(`objectName "${fields.objectName}" not in arr[0]`);
    error.debug = { fields, arr0Keys: Object.keys(array[0] || {}).slice(0, 10) };
    throw error;
  }

  const fragment = b64toU8(object[fields.keyField]);
  const iv = b64toU8(object[fields.ivField]);

  const keyFragmentRaw = data[fields.keyFrag2Field];
  if (!keyFragmentRaw) {
    const error = new Error(`kf2 field "${fields.keyFrag2Field}" not in data`);
    error.debug = { fields, topKeys: Object.keys(data).slice(0, 20) };
    throw error;
  }
  const keyFragment = b64toU8(keyFragmentRaw);

  const token = data[fields.tokenField];
  if (!token) {
    const error = new Error(`tokenField "${fields.tokenField}" missing`);
    error.debug = { fields, topKeys: Object.keys(data).slice(0, 20) };
    throw error;
  }

  const tokenResponse = await fetchImpl(`${apiBase}/api/m3u8/${token}`, { headers: { ...headers, ...(referer ? { Referer: referer } : {}) } });
  if (!tokenResponse.ok) {
    const error = new Error(`Token API ${tokenResponse.status}`);
    error.rawBody = await tokenResponse.text().catch(() => null);
    throw error;
  }
  const tokenData = await tokenResponse.json();

  const videoKey = (await sha256hex(token + "vid")).substring(0, 10);
  const tokenKey = (await sha256hex(token + "key")).substring(0, 10);

  const videoBytes = b64toU8(tokenData[videoKey]);
  const tokenBytes = b64toU8(tokenData[tokenKey]);
  if (!videoBytes.length || !tokenBytes.length) {
    const error = new Error(`Token fields missing. vidKey="${videoKey}" keyKey="${tokenKey}"`);
    error.debug = { tokKeys: Object.keys(tokenData).slice(0, 10) };
    throw error;
  }

  const seedNumber = parseInt(seed.substring(0, 8), 16) || 0;
  const wasmPayload = b64toU8(data.w_payload ?? "");
  if (!wasmPayload.length) throw new Error("w_payload missing from embed data");

  let wasmOut;
  try {
    wasmOut = runDecrypt(wasmPayload, fragment, keyFragment, tokenBytes, seedNumber);
  } catch (err) {
    // attach helpful debug data and rethrow
    err.wasmHex = Array.from(wasmPayload).map((b) => b.toString(16).padStart(2, "0")).join("");
    throw err;
  }

  const material = await crypto.subtle.importKey("raw", wasmOut, { name: "PBKDF2" }, false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(seed), iterations: 1e3, hash: "SHA-256" }, material, 256);
  const derived = new Uint8Array(derivedBits);

  // small obfuscation step from original implementation
  for (let i = 0; i < 32; i++) derived[i] ^= seed.charCodeAt(i % seed.length);

  const aesKeyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", derived));
  const aesKey = await crypto.subtle.importKey("raw", aesKeyBytes, { name: "AES-CBC" }, false, ["decrypt"]);

  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, videoBytes);
  } catch (error) {
    error.debug = {
      seedInt: "0x" + seedNumber.toString(16),
      frag1Len: fragment.length,
      kf2Len: keyFragment.length,
      T_bytesLen: tokenBytes.length,
      ivLen: iv.length,
      v_bytesLen: videoBytes.length,
      wPayloadLen: wasmPayload.length,
      wasmOutHex: Array.from(wasmOut || []).map((b) => b.toString(16).padStart(2, "0")).join("")
    };
    throw error;
  }

  const url = decoder.decode(plain).trim().replace(/\0+$/, "");
  if (!url.startsWith("http")) throw new Error(`Unexpected decrypted value: ${url.substring(0, 60)}`);

  return {
    url,
    subtitles: data.subtitles ?? [],
    thumbnails_vtt: data.thumbnails_vtt ?? null,
    video_title: data.video_title ?? null,
    intro_chapter: data.intro_chapter ?? null,
    outro_chapter: data.outro_chapter ?? null,
    video_id: data.video_id ?? null
  };
}
