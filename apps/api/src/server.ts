import { Readable } from "node:stream";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { CONTENT_TYPES, ENGINE_FORMATS, RESPONSE_FORMATS, type Transcoder, ffmpegTranscoder } from "./audio.js";
import type { Config } from "./config.js";
import { EngineRegistry } from "./engines.js";
import { VoiceError, VoiceStore } from "./voices.js";

/** エンジンの応答から呼び出し元へそのまま返すヘッダ */
const PASSTHROUGH_HEADERS = ["x-tts-metrics", "x-tts-sample-rate"];
/** voice にこれらを渡すと参照音声なしで生成する（OpenAI SDK は voice を必須にしているため） */
const NO_VOICE = new Set(["", "none"]);

interface SpeechBody {
  model?: string;
  input: string;
  voice?: string | { id: string };
  instructions?: string;
  response_format?: string;
  speed?: number;
  stream_format?: "audio" | "sse";
  options?: Record<string, unknown>;
}

const speechSchema = {
  type: "object",
  required: ["input"],
  additionalProperties: false,
  properties: {
    model: { type: "string", minLength: 1 },
    input: { type: "string", minLength: 1, maxLength: 5000 },
    voice: {
      anyOf: [
        { type: "string" },
        { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false }
      ]
    },
    instructions: { type: "string", maxLength: 1000 },
    response_format: { type: "string", enum: RESPONSE_FORMATS },
    speed: { type: "number", minimum: 0.25, maximum: 4 },
    stream_format: { type: "string", enum: ["audio", "sse"] },
    options: { type: "object" }
  }
} as const;

export interface BuildOptions {
  config: Config;
  fetchImpl?: typeof fetch;
  transcoder?: Transcoder;
  logger?: boolean;
}

function apiError(reply: FastifyReply, status: number, code: string, message: string, type = "invalid_request_error") {
  return reply.code(status).send({ error: { message, type, code } });
}

export function buildServer(opts: BuildOptions): FastifyInstance {
  const { config } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const transcoder = opts.transcoder ?? ffmpegTranscoder(config.ffmpegPath);
  const registry = new EngineRegistry(config.engines, doFetch, config.modelsCacheMs);
  const voices = new VoiceStore(config.voicesDir);

  const app = Fastify({
    bodyLimit: config.bodyLimit,
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? "info" }
  });
  void app.register(multipart, { limits: { fileSize: config.maxVoiceBytes, files: 1, fields: 8 } });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown; code?: string }, req, reply) => {
    if (err.validation !== undefined) return apiError(reply, 400, "invalid_request", err.message);
    if (err.code === "FST_REQ_FILE_TOO_LARGE") {
      return apiError(reply, 413, "file_too_large", `参照音声は ${config.maxVoiceBytes} バイトまでです`);
    }
    if (err instanceof VoiceError) return apiError(reply, err.status, err.code, err.message);
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    return apiError(reply, status, status >= 500 ? "internal_error" : "invalid_request", err.message, status >= 500 ? "server_error" : "invalid_request_error");
  });

  // コンテナのヘルスチェック専用
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/health", async () => {
    await registry.refresh();
    const engines = await registry.status();
    return { status: engines.every((e) => e.reachable) ? "ok" : "degraded", engines };
  });

  app.get("/v1/models", async () => {
    const defaultModel = await registry.defaultModel(config.defaultModel);
    const models = await registry.list();
    return { object: "list", data: models.map((m) => ({ ...m, default: m.id === defaultModel })) };
  });

  app.post<{ Body: SpeechBody }>("/v1/audio/speech", { schema: { body: speechSchema } }, async (req, reply) => {
    const body = req.body;
    const format = body.response_format ?? "wav";
    const engineFormat = ENGINE_FORMATS.has(format) ? format : "wav";

    const voiceId = typeof body.voice === "object" ? body.voice.id : (body.voice ?? "");
    const references: string[] = [];
    if (!NO_VOICE.has(voiceId)) {
      if ((await voices.get(voiceId)) === undefined) return apiError(reply, 400, "voice_not_found", `声 ${voiceId} は登録されていません`);
      references.push(voices.referencePath(voiceId));
    }

    const options: Record<string, unknown> = { ...(body.options ?? {}) };
    // OpenAI の instructions（声や話し方の指示）は Irodori のキャプションに当たる
    if (body.instructions !== undefined && body.instructions.trim() !== "" && options.caption === undefined) {
      options.caption = body.instructions;
    }

    const modelId = body.model ?? (await registry.defaultModel(config.defaultModel));
    if (modelId === undefined) return apiError(reply, 502, "engine_unreachable", "どのエンジンにも接続できません", "server_error");
    const engine = await registry.resolve(modelId);
    if (engine === undefined) {
      const states = await registry.status();
      if (states.every((s) => !s.reachable)) {
        return apiError(reply, 502, "engine_unreachable", "どのエンジンにも接続できません", "server_error");
      }
      return apiError(reply, 404, "model_not_found", `モデル ${modelId} はありません`);
    }

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error("upstream timeout")), config.upstreamTimeoutMs);
    // 呼び出し元が切断したらエンジンへの要求も止める（SSE では残りの文を生成しない）
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) abort.abort(new Error("client disconnected"));
    });

    let upstream: Response;
    try {
      upstream = await doFetch(`${engine.baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          input: body.input,
          references,
          speed: body.speed ?? 1,
          response_format: engineFormat,
          stream_format: body.stream_format ?? "audio",
          options
        }),
        signal: abort.signal
      });
    } catch (err) {
      clearTimeout(timeout);
      req.log.error({ err, engine: engine.name }, "engine request failed");
      return apiError(reply, 502, "engine_unreachable", `エンジン ${engine.name} に接続できません`, "server_error");
    }

    if (!upstream.ok) {
      clearTimeout(timeout);
      reply.code(upstream.status).header("content-type", "application/json");
      return reply.send(Buffer.from(await upstream.arrayBuffer()));
    }

    if (body.stream_format === "sse") {
      reply.header("content-type", "text/event-stream").header("cache-control", "no-cache").header("x-accel-buffering", "no");
      const events = relaySse(upstream, format, engineFormat, transcoder, () => clearTimeout(timeout));
      return reply.send(Readable.from(events));
    }

    try {
      let audio: Buffer = Buffer.from(await upstream.arrayBuffer());
      if (format !== engineFormat) audio = await transcoder.fromWav(audio, format);
      for (const name of PASSTHROUGH_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) reply.header(name, value);
      }
      return reply.header("content-type", CONTENT_TYPES[format]).send(audio);
    } finally {
      clearTimeout(timeout);
    }
  });

  app.get("/v1/voices", async () => ({ object: "list", data: await voices.list() }));

  app.get<{ Params: { id: string } }>("/v1/voices/:id", async (req, reply) => {
    const voice = await voices.get(req.params.id);
    if (voice === undefined) return apiError(reply, 404, "voice_not_found", `声 ${req.params.id} は登録されていません`);
    return voice;
  });

  app.get<{ Params: { id: string } }>("/v1/voices/:id/audio", async (req, reply) => {
    const wav = await voices.readReference(req.params.id);
    if (wav === undefined) return apiError(reply, 404, "voice_not_found", `声 ${req.params.id} は登録されていません`);
    return reply.header("content-type", "audio/wav").send(wav);
  });

  app.post("/v1/voices", async (req, reply) => {
    if (!req.isMultipart()) return apiError(reply, 400, "invalid_request", "multipart/form-data で file を送ってください");
    const fields: Record<string, string> = {};
    let file: { data: Buffer<ArrayBufferLike>; filename: string } | undefined;
    for await (const part of req.parts()) {
      if (part.type === "file") file = { data: await part.toBuffer(), filename: part.filename };
      else if (typeof part.value === "string") fields[part.fieldname] = part.value;
    }
    if (file === undefined || file.data.length === 0) return apiError(reply, 400, "file_required", "参照音声の file がありません");
    let converted: { wav: Buffer; seconds: number };
    try {
      converted = await transcoder.toReferenceWav(file.data);
    } catch (err) {
      req.log.warn({ err }, "voice conversion failed");
      return apiError(reply, 400, "invalid_audio", "音声ファイルとして読めませんでした");
    }
    if (converted.seconds < 1) return apiError(reply, 400, "audio_too_short", "参照音声は1秒以上にしてください");
    const voice = await voices.create({
      id: fields.id || undefined,
      name: fields.name,
      transcript: fields.transcript,
      wav: converted.wav,
      seconds: converted.seconds,
      originalFilename: file.filename
    });
    return reply.code(201).send(voice);
  });

  app.delete<{ Params: { id: string } }>("/v1/voices/:id", async (req, reply) => {
    if (!(await voices.delete(req.params.id))) {
      return apiError(reply, 404, "voice_not_found", `声 ${req.params.id} は登録されていません`);
    }
    return { id: req.params.id, object: "voice", deleted: true };
  });

  app.setNotFoundHandler((_req, reply) => apiError(reply, 404, "not_found", "not found"));
  return app;
}

/** エンジンの SSE をそのまま流す。wav/pcm 以外の形式は各文の音声を変換してから流す */
async function* relaySse(
  upstream: Response,
  format: string,
  engineFormat: string,
  transcoder: Transcoder,
  onEnd: () => void
): AsyncGenerator<string> {
  try {
    if (upstream.body === null) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        yield await convertEvent(raw, format, engineFormat, transcoder);
      }
    }
    if (buffer.trim() !== "") yield await convertEvent(buffer, format, engineFormat, transcoder);
  } finally {
    onEnd();
  }
}

async function convertEvent(raw: string, format: string, engineFormat: string, transcoder: Transcoder): Promise<string> {
  if (format === engineFormat || !raw.startsWith("data: ")) return `${raw}\n\n`;
  const event = JSON.parse(raw.slice("data: ".length)) as { type?: string; audio?: string };
  if (event.type !== "speech.audio.delta" || event.audio === undefined) return `${raw}\n\n`;
  const converted = await transcoder.fromWav(Buffer.from(event.audio, "base64"), format);
  return `data: ${JSON.stringify({ ...event, audio: converted.toString("base64") })}\n\n`;
}
