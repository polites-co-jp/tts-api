import type { EngineEndpoint } from "./config.js";

export interface EngineModel {
  id: string;
  object: "model";
  engine: string;
  status?: string;
  default?: boolean;
  [key: string]: unknown;
}

export interface EngineState {
  name: string;
  baseUrl: string;
  reachable: boolean;
  error?: string;
}

/** 各エンジンの /v1/models を集めて、モデル名からエンジンを引けるようにする */
export class EngineRegistry {
  private models: EngineModel[] = [];
  private owners = new Map<string, EngineEndpoint>();
  private states: EngineState[] = [];
  private fetchedAt = -Infinity;

  constructor(
    readonly engines: EngineEndpoint[],
    private readonly doFetch: typeof fetch,
    private readonly cacheMs: number,
    private readonly now: () => number = Date.now
  ) {}

  async refresh(): Promise<void> {
    const results = await Promise.all(
      this.engines.map(async (engine) => {
        try {
          const res = await this.doFetch(`${engine.baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { data?: EngineModel[] };
          return { engine, models: body.data ?? [], error: undefined };
        } catch (err) {
          return { engine, models: [] as EngineModel[], error: err instanceof Error ? err.message : String(err) };
        }
      })
    );
    const models: EngineModel[] = [];
    const owners = new Map<string, EngineEndpoint>();
    const states: EngineState[] = [];
    for (const { engine, models: list, error } of results) {
      states.push({ name: engine.name, baseUrl: engine.baseUrl, reachable: error === undefined, ...(error ? { error } : {}) });
      for (const model of list) {
        // 同じ名前のモデルが複数のエンジンにあれば、ENGINES で先に書いたほうを使う
        if (owners.has(model.id)) continue;
        owners.set(model.id, engine);
        models.push({ ...model, engine: engine.name });
      }
    }
    this.models = models;
    this.owners = owners;
    this.states = states;
    this.fetchedAt = this.now();
  }

  private async ensureFresh(): Promise<void> {
    if (this.now() - this.fetchedAt > this.cacheMs) await this.refresh();
  }

  async list(): Promise<EngineModel[]> {
    await this.ensureFresh();
    return this.models;
  }

  async status(): Promise<EngineState[]> {
    await this.ensureFresh();
    return this.states;
  }

  /** モデル名に対応するエンジン。見つからなければ一覧を取り直してもう一度探す */
  async resolve(modelId: string): Promise<EngineEndpoint | undefined> {
    await this.ensureFresh();
    const owner = this.owners.get(modelId);
    if (owner !== undefined) return owner;
    await this.refresh();
    return this.owners.get(modelId);
  }

  /** 既定モデル。指定がなければ最初のエンジンが既定とするモデル */
  async defaultModel(configured: string): Promise<string | undefined> {
    if (configured !== "") return configured;
    const models = await this.list();
    return (models.find((m) => m.default === true) ?? models[0])?.id;
  }
}
