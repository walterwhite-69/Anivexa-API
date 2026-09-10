import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const WORKER_PATH = fileURLToPath(new URL("../workers/curlcffi-worker.py", import.meta.url));
const RESPONSE_HEADERS_TO_SKIP = new Set(["content-encoding", "content-length", "transfer-encoding"]);

let worker = null;
let output = "";
let workerError = "";
const pending = new Map();

function rejectAll(error) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
}

function handleMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const request = pending.get(message?.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(`curl_cffi worker: ${message.error}`));
  else request.resolve(message);
}

function startWorker() {
  if (worker && !worker.killed) return worker;
  const python = process.env.CURL_CFFI_PYTHON || process.env.PYTHON || "python";
  worker = spawn(python, ["-u", WORKER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  output = "";
  workerError = "";
  worker.unref();
  worker.stdin.unref?.();
  worker.stdout.unref?.();
  worker.stderr.unref?.();
  worker.stdout.setEncoding("utf8");
  worker.stderr.setEncoding("utf8");
  worker.stdout.on("data", (chunk) => {
    output += chunk;
    let newline;
    while ((newline = output.indexOf("\n")) !== -1) {
      handleMessage(output.slice(0, newline));
      output = output.slice(newline + 1);
    }
  });
  worker.stderr.on("data", (chunk) => {
    workerError = `${workerError}${chunk}`.slice(-2000);
  });
  worker.on("error", (error) => {
    worker = null;
    rejectAll(new Error(`curl_cffi worker failed: ${error.message}`));
  });
  worker.on("exit", (code, signal) => {
    worker = null;
    const detail = workerError.trim();
    rejectAll(new Error(`curl_cffi worker exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""})${detail ? `: ${detail}` : ""}`));
  });
  return worker;
}

function transportText(value) {
  return Buffer.from(String(value), "utf8").toString("utf8");
}

function toHeaders(headers) {
  return Object.fromEntries(
    [...new Headers(headers ?? {}).entries()].map(([name, value]) => [transportText(name), transportText(value)])
  );
}

function toBody(body) {
  if (body === undefined || body === null) return { body: null, bodyEncoding: null };
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    return { body: Buffer.from(body).toString("base64"), bodyEncoding: "base64" };
  }
  if (body instanceof URLSearchParams) return { body: transportText(body), bodyEncoding: "utf8" };
  return { body: transportText(body), bodyEncoding: "utf8" };
}

function toWarmRequests(warm) {
  return (warm ?? []).map((item) => {
    const requestBody = toBody(item.body);
    return {
      method: item.method ?? "GET",
      url: transportText(item.url),
      headers: toHeaders(item.headers),
      ...requestBody,
      redirect: item.redirect !== "manual",
    };
  });
}

function responseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !RESPONSE_HEADERS_TO_SKIP.has(name.toLowerCase())));
}

function send(message, timeoutMs) {
  const child = startWorker();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`curl_cffi worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ ...message, id })}\n`, (error) => {
      if (!error) return;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function curlCffiFetch(url, options = {}) {
  const {
    session = "default",
    impersonate = "chrome",
    warm,
    timeoutMs = 30000,
    method = "GET",
    headers,
    body,
    redirect,
  } = options;
  const requestBody = toBody(body);
  const result = await send({
    session,
    impersonate,
    warm: toWarmRequests(warm),
    method,
    url: transportText(url),
    headers: toHeaders(headers),
    ...requestBody,
    redirect: redirect !== "manual",
    timeoutMs,
  }, timeoutMs);
  return new Response(result.body ?? "", {
    status: result.status,
    headers: responseHeaders(result.headers),
  });
}

export function stopCurlCffiWorker() {
  if (!worker) return;
  worker.kill();
  worker = null;
}

process.once("exit", () => stopCurlCffiWorker());
