import { fileURLToPath } from "node:url";
import { buildChatServer } from "./server.js";

const apiUrl = (process.env.TTS_API_URL ?? "http://api:8080").replace(/\/+$/, "");
const port = Number(process.env.PORT ?? 3000);
const publicDir = fileURLToPath(new URL("../public", import.meta.url));

const server = buildChatServer(apiUrl, publicDir);
server.listen(port, "0.0.0.0", () => {
  console.log(`chat listening on :${port} (api: ${apiUrl})`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
