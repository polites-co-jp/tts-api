import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Voice {
  id: string;
  name: string;
  /** 参照音声の書き起こし（任意）。今のエンジンは使わないが、書き起こしを要る TTS のために持っておく */
  transcript: string | null;
  duration_seconds: number;
  original_filename: string | null;
  created_at: string;
}

export const VOICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REFERENCE_FILE = "ref.wav";
const META_FILE = "voice.json";

export class VoiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** 声は <dir>/<id>/ref.wav と voice.json の組で持つ。エンジンへはこのディレクトリを読み取り専用で共有する */
export class VoiceStore {
  constructor(readonly dir: string) {}

  referencePath(id: string): string {
    return join(this.dir, id, REFERENCE_FILE);
  }

  async list(): Promise<Voice[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const voices: Voice[] = [];
    for (const id of entries) {
      if (!VOICE_ID_PATTERN.test(id)) continue;
      const voice = await this.get(id);
      if (voice !== undefined) voices.push(voice);
    }
    return voices.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async get(id: string): Promise<Voice | undefined> {
    if (!VOICE_ID_PATTERN.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(join(this.dir, id, META_FILE), "utf8")) as Voice;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async readReference(id: string): Promise<Buffer | undefined> {
    if ((await this.get(id)) === undefined) return undefined;
    return readFile(this.referencePath(id));
  }

  async create(input: {
    id?: string;
    name?: string;
    transcript?: string;
    wav: Buffer;
    seconds: number;
    originalFilename?: string;
    now?: Date;
  }): Promise<Voice> {
    const id = input.id ?? `voice_${randomBytes(6).toString("hex")}`;
    if (!VOICE_ID_PATTERN.test(id)) {
      throw new VoiceError(400, "invalid_voice_id", "声の ID は英数字で始まり、英数字・_・- だけで 64 文字以内にしてください");
    }
    if ((await this.get(id)) !== undefined) {
      throw new VoiceError(409, "voice_exists", `声 ${id} はすでにあります`);
    }
    const voice: Voice = {
      id,
      name: input.name?.trim() || id,
      transcript: input.transcript?.trim() || null,
      duration_seconds: Math.round(input.seconds * 1000) / 1000,
      original_filename: input.originalFilename ?? null,
      created_at: (input.now ?? new Date()).toISOString()
    };
    // 書きかけの声が一覧に出ないよう、一時ディレクトリに揃えてから名前を変える
    const staging = join(this.dir, `.staging-${randomBytes(6).toString("hex")}`);
    await mkdir(staging, { recursive: true });
    try {
      await writeFile(join(staging, REFERENCE_FILE), input.wav);
      await writeFile(join(staging, META_FILE), JSON.stringify(voice, null, 2));
      await rename(staging, join(this.dir, id));
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
    return voice;
  }

  async delete(id: string): Promise<boolean> {
    if ((await this.get(id)) === undefined) return false;
    await rm(join(this.dir, id), { recursive: true, force: true });
    return true;
  }
}
