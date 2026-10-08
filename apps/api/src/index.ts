import { Agent, fetch as undiciFetch } from "undici";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
// fetch（undici）は既定でヘッダを 300 秒しか待たない。大きいモデルは初回の取得と読み込みでそれを超えるので、
// エンジンを待つ時間は UPSTREAM_TIMEOUT_MS に揃える
const dispatcher = new Agent({ headersTimeout: config.upstreamTimeoutMs, bodyTimeout: config.upstreamTimeoutMs });
const fetchImpl = ((input: string, init?: RequestInit) =>
  undiciFetch(input, { ...(init as object), dispatcher })) as unknown as typeof fetch;
const app = buildServer({ config, fetchImpl });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

app.listen({ port: config.port, host: config.host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
