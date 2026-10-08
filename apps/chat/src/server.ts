import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

/** UI の /api/* から api へ中継してよいパス。api は認証を持たないので、中継先はこの範囲に絞る */
const PROXY_PATHS = [/^\/health$/, /^\/v1\/models$/, /^\/v1\/audio\/speech$/, /^\/v1\/voices$/, /^\/v1\/voices\/[A-Za-z0-9_-]+(\/audio)?$/];

/** api から UI へ渡すヘッダ */
const PASSTHROUGH = new Set(["content-type", "cache-control", "x-tts-metrics", "x-tts-sample-rate"]);

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

async function proxy(req: IncomingMessage, res: ServerResponse, apiUrl: string, path: string, search: string) {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE";
  const headers: Record<string, string> = {};
  if (hasBody && req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  // 本文（SSE の応答・参照音声のアップロード）はバッファせずストリームのまま流す
  const upstream = await fetch(`${apiUrl}${path}${search}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    duplex: "half",
    signal: abort.signal
  } as RequestInit);
  const out: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    if (PASSTHROUGH.has(k)) out[k] = v;
  });
  if (out["content-type"]?.startsWith("text/event-stream")) out["x-accel-buffering"] = "no";
  res.writeHead(upstream.status, out);
  if (upstream.body === null) return res.end();
  for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
}

export function buildChatServer(apiUrl: string, publicDir: string): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        const path = url.pathname.slice("/api".length);
        if (!PROXY_PATHS.some((re) => re.test(path))) return send(res, 404, "not found");
        return await proxy(req, res, apiUrl, path, url.search);
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(res, 200, '{"ok":true}', { "content-type": "application/json" });
      }

      if (req.method === "GET") {
        const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^([/\\])+/, "");
        if (rel.startsWith("..")) return send(res, 404, "not found");
        const type = MIME[extname(rel)];
        if (!type) return send(res, 404, "not found");
        const file = await readFile(join(publicDir, rel)).catch(() => undefined);
        if (!file) return send(res, 404, "not found");
        return send(res, 200, file, { "content-type": type, "cache-control": "no-store" });
      }
      return send(res, 404, "not found");
    } catch (err) {
      if (res.headersSent) return res.destroy();
      console.error(err);
      return send(res, 502, JSON.stringify({ error: { message: "api に接続できません", type: "server_error", code: "api_unreachable" } }), {
        "content-type": "application/json"
      });
    }
  });
}
