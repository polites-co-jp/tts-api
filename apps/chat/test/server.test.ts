import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChatServer } from "../src/server.js";

let api: Server;
let chat: Server;
let publicDir: string;
let received: { method: string; url: string; contentType?: string; body: string }[];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

beforeEach(async () => {
  received = [];
  publicDir = await mkdtemp(join(tmpdir(), "tts-chat-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>t</title>");
  api = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received.push({ method: req.method ?? "", url: req.url ?? "", contentType: req.headers["content-type"], body: Buffer.concat(chunks).toString() });
    if (req.url === "/v1/audio/speech") {
      res.writeHead(200, { "content-type": "text/event-stream", "x-internal": "no" });
      res.write('data: {"type":"speech.audio.delta"}\n\n');
      setTimeout(() => res.end('data: {"type":"speech.audio.done"}\n\n'), 20);
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-tts-metrics": "{}" });
    res.end('{"object":"list","data":[]}');
  });
});

afterEach(async () => {
  await new Promise((r) => chat?.close(r));
  await new Promise((r) => api?.close(r));
  await rm(publicDir, { recursive: true, force: true });
});

describe("chat server", () => {
  it("serves the UI", async () => {
    chat = buildChatServer(await listen(api), publicDir);
    const base = await listen(chat);
    const res = await fetch(`${base}/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>t</title>");
    expect((await fetch(`${base}/../secret.html`)).status).toBe(404);
  });

  it("proxies allowed api paths and passes selected headers", async () => {
    chat = buildChatServer(await listen(api), publicDir);
    const base = await listen(chat);
    const res = await fetch(`${base}/api/v1/models`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-tts-metrics")).toBe("{}");
    expect(received[0]).toMatchObject({ method: "GET", url: "/v1/models" });
  });

  it("streams SSE and forwards request bodies", async () => {
    chat = buildChatServer(await listen(api), publicDir);
    const base = await listen(chat);
    const res = await fetch(`${base}/api/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "テスト", stream_format: "sse" })
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-internal")).toBeNull();
    expect(await res.text()).toBe('data: {"type":"speech.audio.delta"}\n\ndata: {"type":"speech.audio.done"}\n\n');
    expect(received[0]).toMatchObject({ method: "POST", contentType: "application/json", body: '{"input":"テスト","stream_format":"sse"}' });
  });

  it("forwards DELETE for a voice and rejects paths outside the allowlist", async () => {
    chat = buildChatServer(await listen(api), publicDir);
    const base = await listen(chat);
    expect((await fetch(`${base}/api/v1/voices/alice`, { method: "DELETE" })).status).toBe(200);
    expect(received[0]).toMatchObject({ method: "DELETE", url: "/v1/voices/alice" });
    expect((await fetch(`${base}/api/v1/voices/../../etc`)).status).toBe(404);
    expect((await fetch(`${base}/api/admin`)).status).toBe(404);
  });

  it("returns 502 when the api is down", async () => {
    chat = buildChatServer("http://127.0.0.1:1", publicDir);
    const base = await listen(chat);
    const res = await fetch(`${base}/api/v1/models`);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("api_unreachable");
  });
});
