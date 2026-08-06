import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp({ config });

let closing = false;

async function close(signal: string): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  app.log.info({ signal }, "shutting down");

  const timeout = setTimeout(() => {
    app.log.error("graceful shutdown timed out");
    process.exitCode = 1;
  }, config.server.shutdownGraceMs);
  timeout.unref();

  try {
    await app.close();
  } finally {
    clearTimeout(timeout);
  }
}

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

try {
  await app.listen({ host: config.server.host, port: config.server.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
