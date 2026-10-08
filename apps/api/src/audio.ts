import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** エンジンが直接返せる形式。それ以外は wav を受け取って ffmpeg で変換する */
export const ENGINE_FORMATS = new Set(["wav", "pcm"]);

export const CONTENT_TYPES: Record<string, string> = {
  wav: "audio/wav",
  pcm: "audio/pcm",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac"
};

export const RESPONSE_FORMATS = Object.keys(CONTENT_TYPES);

const FFMPEG_OUTPUT_ARGS: Record<string, string[]> = {
  mp3: ["-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"],
  opus: ["-c:a", "libopus", "-b:a", "64k", "-f", "ogg"],
  aac: ["-c:a", "aac", "-b:a", "128k", "-f", "adts"],
  flac: ["-c:a", "flac", "-f", "flac"]
};

export interface Transcoder {
  /** wav を指定形式へ変換する */
  fromWav(wav: Buffer, format: string): Promise<Buffer>;
  /** 任意の音声ファイルを声の参照用 wav（モノラル・48kHz・16bit）にする。戻り値は wav と長さ（秒） */
  toReferenceWav(input: Buffer): Promise<{ wav: Buffer; seconds: number }>;
}

function run(ffmpegPath: string, args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", ...args], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited with ${code}: ${Buffer.concat(err).toString().trim()}`));
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(input);
  });
}

export interface WavInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
}

/** RIFF のチャンクを辿って fmt と data を探す。パイプ出力でサイズ欄が未確定でも data は末尾までとみなす */
export function parseWav(wav: Buffer): WavInfo | undefined {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return undefined;
  }
  let offset = 12;
  let fmt: Pick<WavInfo, "channels" | "sampleRate" | "bitsPerSample"> | undefined;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= wav.length) {
      fmt = { channels: wav.readUInt16LE(body + 2), sampleRate: wav.readUInt32LE(body + 4), bitsPerSample: wav.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (fmt === undefined) return undefined;
      const dataLength = Math.min(size, wav.length - body);
      return { ...fmt, dataOffset: body, dataLength };
    }
    offset = body + size + (size % 2);
  }
  return undefined;
}

export function wavSeconds(wav: Buffer): number {
  const info = parseWav(wav);
  if (info === undefined) return 0;
  const bytesPerSecond = info.sampleRate * info.channels * (info.bitsPerSample / 8);
  return bytesPerSecond > 0 ? info.dataLength / bytesPerSecond : 0;
}

/** RIFF と data のサイズ欄を実際の長さに書き直す */
export function fixWavHeader(wav: Buffer): Buffer {
  const info = parseWav(wav);
  if (info === undefined) throw new Error("not a wav file");
  const fixed = Buffer.from(wav.subarray(0, info.dataOffset + info.dataLength));
  fixed.writeUInt32LE(fixed.length - 8, 4);
  fixed.writeUInt32LE(info.dataLength, info.dataOffset - 4);
  return fixed;
}

export function ffmpegTranscoder(ffmpegPath: string): Transcoder {
  return {
    async fromWav(wav, format) {
      const args = FFMPEG_OUTPUT_ARGS[format];
      if (args === undefined) throw new Error(`unsupported format: ${format}`);
      return run(ffmpegPath, ["-f", "wav", "-i", "pipe:0", ...args, "pipe:1"], wav);
    },
    async toReferenceWav(input) {
      // m4a など末尾にインデックスを持つ形式はシークが要るので、パイプではなく一時ファイルから読む
      const src = join(tmpdir(), `voice-${randomUUID()}`);
      await writeFile(src, input);
      try {
        const raw = await run(
          ffmpegPath,
          ["-i", src, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-bitexact", "-f", "wav", "pipe:1"],
          Buffer.alloc(0)
        );
        const wav = fixWavHeader(raw);
        return { wav, seconds: wavSeconds(wav) };
      } finally {
        await rm(src, { force: true });
      }
    }
  };
}
