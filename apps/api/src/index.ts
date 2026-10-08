import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const app = buildServer({ config });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

app.listen({ port: config.port, host: config.host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
