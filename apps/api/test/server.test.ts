import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transcoder } from "../src/audio.js";
import { parseEngines, type Config } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { makeWav } from "./helpers.js";

const MODELS = {
  object: "list",
  data: [
    { id: "irodori-v4.1-small", object: "model", engine: "irodori", default: true, status: "loaded" },
    { id: "irodori-v4.1-small-mf", object: "model", engine: "irodori", default: false, status: "available" }
  ]
};

type Upstream = (url: string, init: RequestInit) => Response | Promise<Response>;

let voicesDir: string;
let app: ReturnType<typeof buildServer> | undefined;

beforeEach(async () => {
  voicesDir = await mkdtemp(join(tmpdir(), "tts-api-voices-"));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(voicesDir, { recursive: true, force: true });
});

const fakeTranscoder: Transcoder = {
  fromWav: vi.fn(async (wav: Buffer, format: string) => Buffer.concat([Buffer.from(`${format}:`), wav.subarray(0, 4)])),
  toReferenceWav: vi.fn(async (input: Buffer) => {
    if (input.toString() === "garbage") throw new Error("ffmpeg failed");
    if (input.toString() === "short") return { wav: makeWav(4800), seconds: 0.1 };
    return { wav: makeWav(96000), seconds: 2 };
  })
};

function setup(upstream: Upstream, overrides: Partial<Config> = {}) {
  const config: Config = {
    port: 0,
    host: "127.0.0.1",
    engines: parseEngines("irodori=http://engine-irodori:8000"),
    defaultModel: "",
    voicesDir,
    ffmpegPath: "ffmpeg",
    upstreamTimeoutMs: 5000,
    modelsCacheMs: 60000,
    maxVoiceBytes: 1024 * 1024,
    bodyLimit: 1024 * 1024,
    ...overrides
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return Response.json(MODELS);
    return upstream(u, init ?? {});
  });
  app = buildServer({ config, fetchImpl: fetchImpl as unknown as typeof fetch, transcoder: fakeTranscoder, logger: false });
  return { app, fetchImpl };
}

function engineCalls(fetchImpl: ReturnType<typeof setup>["fetchImpl"]) {
  return fetchImpl.mock.calls
    .filter(([url]) => String(url).endsWith("/v1/audio/speech"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

function multipart(fields: Record<string, string>, file?: { name: string; data: Buffer }) {
  const boundary = "----tts-api-test";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      file.data,
      Buffer.from("\r\n")
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const wavResponse = () =>
  new Response(new Uint8Array(makeWav(4800)), {
    status: 200,
    headers: { "content-type": "audio/wav", "x-tts-metrics": '{"model":"irodori-v4.1-small","rtf":0.2}', "x-tts-sample-rate": "48000" }
  });

describe("models", () => {
  it("lists engine models with the engine name and default flag", async () => {
    const { app } = setup(() => new Response(null, { status: 500 }));
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { id: string; engine: string; default: boolean }[];
    expect(data.map((m) => [m.id, m.engine, m.default])).toEqual([
      ["irodori-v4.1-small", "irodori", true],
      ["irodori-v4.1-small-mf", "irodori", false]
    ]);
  });

  it("DEFAULT_MODEL overrides the engine default", async () => {
    const { app } = setup(() => new Response(null, { status: 500 }), { defaultModel: "irodori-v4.1-small-mf" });
    const data = (await app.inject({ method: "GET", url: "/v1/models" })).json().data as { id: string; default: boolean }[];
    expect(data.find((m) => m.default)?.id).toBe("irodori-v4.1-small-mf");
  });
});

describe("speech", () => {
  it("forwards to the engine that owns the model and passes metrics through", async () => {
    const { app, fetchImpl } = setup(wavResponse);
    const res = await app.inject({
      method: "POST",
      url: "/v1/audio/speech",
      payload: { model: "irodori-v4.1-small-mf", input: "こんにちは", speed: 1.2, options: { num_steps: 4 } }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/wav");
    expect(res.headers["x-tts-metrics"]).toContain("rtf");
    expect(fetchImpl.mock.calls.some(([url]) => String(url) === "http://engine-irodori:8000/v1/audio/speech")).toBe(true);
    expect(engineCalls(fetchImpl)[0]).toEqual({
      model: "irodori-v4.1-small-mf",
      input: "こんにちは",
      references: [],
      speed: 1.2,
      response_format: "wav",
      stream_format: "audio",
      options: { num_steps: 4 }
    });
  });

  it("uses the default model when model is omitted and maps instructions to caption", async () => {
    const { app, fetchImpl } = setup(wavResponse);
    await app.inject({ method: "POST", url: "/v1/audio/speech", payload: { input: "テスト", voice: "none", instructions: "落ち着いた声" } });
    const call = engineCalls(fetchImpl)[0];
    expect(call?.model).toBe("irodori-v4.1-small");
    expect(call?.options).toEqual({ caption: "落ち着いた声" });
  });

  it("transcodes formats the engine cannot produce", async () => {
    const { app, fetchImpl } = setup(wavResponse);
    const res = await app.inject({ method: "POST", url: "/v1/audio/speech", payload: { input: "テスト", response_format: "mp3" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mpeg");
    expect(res.rawPayload.toString().startsWith("mp3:RIFF")).toBe(true);
    expect(engineCalls(fetchImpl)[0]?.response_format).toBe("wav");
  });

  it("rejects unknown voices and models", async () => {
    const { app } = setup(wavResponse);
    const voice = await app.inject({ method: "POST", url: "/v1/audio/speech", payload: { input: "テスト", voice: "alloy" } });
    expect(voice.statusCode).toBe(400);
    expect(voice.json().error.code).toBe("voice_not_found");
    const model = await app.inject({ method: "POST", url: "/v1/audio/speech", payload: { input: "テスト", model: "nope" } });
    expect(model.statusCode).toBe(404);
    expect(model.json().error.code).toBe("model_not_found");
  });

  it("validates the request body", async () => {
    const { app } = setup(wavResponse);
    const res = await app.inject({ method: "POST", url: "/v1/audio/speech", payload: { input: "", speed: 10 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("passes engine errors through with their status", async () => {
    const { app } = setup(() =>
      Response.json({ error: { message: "VRAM が足りません", type: "server_error", code: "insufficient_vram" } }, { status: 503 })
    );
    const res = await app.inject({ method: "POST", url: "/v1/audio/speech", payload: { input: "テスト" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("insufficient_vram");
  });

  it("reports an unreachable engine as 502", async () => {
    const { app } = setup(() => {
      throw new TypeError("fetch failed");
    });
    const res = await app.inject({ method: "POST", url: "/v1/audio/speech", payload: { input: "テスト" } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("engine_unreachable");
  });

  it("relays SSE events and transcodes each segment", async () => {
    const delta = (i: number) =>
      `data: ${JSON.stringify({ type: "speech.audio.delta", audio: makeWav(480).toString("base64"), segment: { index: i, count: 2 } })}\n\n`;
    const done = `data: ${JSON.stringify({ type: "speech.audio.done", metrics: { segments: 2 } })}\n\n`;
    const { app } = setup(() => {
      // 区切りの途中でチャンクが切れても組み立て直せることを確かめる
      const text = delta(0) + delta(1) + done;
      const chunks = [text.slice(0, 50), text.slice(50, 2000), text.slice(2000)];
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/audio/speech",
      payload: { input: "テスト。テスト。", stream_format: "sse", response_format: "opus" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const events = res.body
      .split("\n\n")
      .filter((e) => e.startsWith("data: "))
      .map((e) => JSON.parse(e.slice(6)) as { type: string; audio?: string; segment?: { index: number } });
    expect(events.map((e) => e.type)).toEqual(["speech.audio.delta", "speech.audio.delta", "speech.audio.done"]);
    expect(Buffer.from(events[0]?.audio ?? "", "base64").toString().startsWith("opus:RIFF")).toBe(true);
    expect(events[1]?.segment?.index).toBe(1);
  });
});

describe("voices", () => {
  it("registers, lists, plays and deletes a voice, and speech sends its reference path", async () => {
    const { app, fetchImpl } = setup(wavResponse);
    const upload = multipart({ id: "alice", name: "アリス", transcript: "こんにちは" }, { name: "alice.m4a", data: Buffer.from("audio") });
    const created = await app.inject({ method: "POST", url: "/v1/voices", ...upload });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: "alice", name: "アリス", transcript: "こんにちは", duration_seconds: 2, original_filename: "alice.m4a" });

    const list = await app.inject({ method: "GET", url: "/v1/voices" });
    expect((list.json().data as { id: string }[]).map((v) => v.id)).toEqual(["alice"]);

    const audio = await app.inject({ method: "GET", url: "/v1/voices/alice/audio" });
    expect(audio.headers["content-type"]).toBe("audio/wav");
    expect(audio.rawPayload.toString("ascii", 0, 4)).toBe("RIFF");

    await app.inject({ method: "POST", url: "/v1/audio/speech", payload: { input: "テスト", voice: { id: "alice" } } });
    expect(engineCalls(fetchImpl)[0]?.references).toEqual([join(voicesDir, "alice", "ref.wav")]);

    const dup = await app.inject({ method: "POST", url: "/v1/voices", ...multipart({ id: "alice" }, { name: "a.wav", data: Buffer.from("audio") }) });
    expect(dup.statusCode).toBe(409);

    const deleted = await app.inject({ method: "DELETE", url: "/v1/voices/alice" });
    expect(deleted.json()).toEqual({ id: "alice", object: "voice", deleted: true });
    expect((await app.inject({ method: "GET", url: "/v1/voices/alice" })).statusCode).toBe(404);
  });

  it("generates an id when none is given", async () => {
    const { app } = setup(wavResponse);
    const res = await app.inject({ method: "POST", url: "/v1/voices", ...multipart({}, { name: "x.wav", data: Buffer.from("audio") }) });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toMatch(/^voice_[0-9a-f]{12}$/);
  });

  it("rejects bad uploads", async () => {
    const { app } = setup(wavResponse);
    const noFile = await app.inject({ method: "POST", url: "/v1/voices", ...multipart({ name: "x" }) });
    expect(noFile.json().error.code).toBe("file_required");
    const garbage = await app.inject({ method: "POST", url: "/v1/voices", ...multipart({}, { name: "x", data: Buffer.from("garbage") }) });
    expect(garbage.json().error.code).toBe("invalid_audio");
    const short = await app.inject({ method: "POST", url: "/v1/voices", ...multipart({}, { name: "x", data: Buffer.from("short") }) });
    expect(short.json().error.code).toBe("audio_too_short");
    const badId = await app.inject({ method: "POST", url: "/v1/voices", ...multipart({ id: "../etc" }, { name: "x", data: Buffer.from("audio") }) });
    expect(badId.statusCode).toBe(400);
    expect(badId.json().error.code).toBe("invalid_voice_id");
    const tooBig = await app.inject({
      method: "POST",
      url: "/v1/voices",
      ...multipart({}, { name: "x", data: Buffer.alloc(2 * 1024 * 1024) })
    });
    expect(tooBig.statusCode).toBe(413);
  });
});

describe("health", () => {
  it("reports engine reachability", async () => {
    const { app } = setup(wavResponse);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({
      status: "ok",
      engines: [{ name: "irodori", baseUrl: "http://engine-irodori:8000", reachable: true }]
    });
  });
});

describe("config", () => {
  it("parses ENGINES", () => {
    expect(parseEngines("a=http://a:1/, b = http://b:2")).toEqual([
      { name: "a", baseUrl: "http://a:1" },
      { name: "b", baseUrl: "http://b:2" }
    ]);
    expect(() => parseEngines("")).toThrow();
    expect(() => parseEngines("nourl")).toThrow();
  });
});
