export interface EngineEndpoint {
  name: string;
  baseUrl: string;
}

export interface Config {
  port: number;
  host: string;
  engines: EngineEndpoint[];
  /** model を省略したときに使うモデル。空ならエンジンが既定とするモデル */
  defaultModel: string;
  /** 声の置き場。エンジンにも同じパスで読み取り専用でマウントする */
  voicesDir: string;
  ffmpegPath: string;
  /** モデルの初回取得・読み込みを含めて待つ時間 */
  upstreamTimeoutMs: number;
  modelsCacheMs: number;
  maxVoiceBytes: number;
  bodyLimit: number;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

/** ENGINES="irodori=http://engine-irodori:8000,other=http://engine-other:8000" */
export function parseEngines(raw: string): EngineEndpoint[] {
  const engines = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) throw new Error(`ENGINES entry must be name=url: ${part}`);
      return { name: part.slice(0, eq).trim(), baseUrl: part.slice(eq + 1).trim().replace(/\/+$/, "") };
    });
  if (engines.length === 0) throw new Error("ENGINES must list at least one engine");
  return engines;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env, "PORT", 8080),
    host: env.HOST ?? "0.0.0.0",
    engines: parseEngines(env.ENGINES ?? "irodori=http://engine-irodori:8000"),
    defaultModel: env.DEFAULT_MODEL ?? "",
    voicesDir: env.VOICES_DIR ?? "/data/voices",
    ffmpegPath: env.FFMPEG_PATH ?? "ffmpeg",
    upstreamTimeoutMs: int(env, "UPSTREAM_TIMEOUT_MS", 15 * 60 * 1000),
    modelsCacheMs: int(env, "MODELS_CACHE_MS", 5000),
    maxVoiceBytes: int(env, "MAX_VOICE_BYTES", 30 * 1024 * 1024),
    bodyLimit: 1024 * 1024
  };
}
