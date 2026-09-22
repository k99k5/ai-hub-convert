import { createConnection } from "node:net";
import { createServer, request } from "node:http";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { RequestDrain } from "../http/request-drain.js";

export type DrainOperation = "status" | "drain" | "resume";
export interface DrainStatus {
  version: 1;
  pid: number;
  draining: boolean;
  activeRequests: number;
}

export function controlSocketPath(): string {
  return (
    process.env.GATEWAY_CONTROL_SOCKET ??
    (process.platform === "win32"
      ? "\\\\.\\pipe\\llm-protocol-gateway-control"
      : join(tmpdir(), "llm-gateway-control", "control.sock"))
  );
}

async function prepareSocket(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0)
    throw new Error("Control socket requires a private directory owned by the gateway user");
  const prior = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!prior) return;
  if (!prior.isSocket()) throw new Error("Control socket path is occupied by a non-socket file");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("Another gateway is using the control socket"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
      else reject(error);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error("Control socket probe timed out"));
    });
  });
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

// Separate Unix socket, never a public API route or a loopback HTTP bypass.
// Container operators use docker exec; the directory and socket are owner-only.
export async function startDrainControl(drain: RequestDrain, path = controlSocketPath()) {
  await prepareSocket(path);
  const server = createServer({ requestTimeout: 3000, headersTimeout: 3000 }, (req, res) => {
    req.resume();
    if (req.method === "POST" && req.url === "/drain") drain.begin();
    else if (req.method === "POST" && req.url === "/resume") drain.resume();
    else if (req.method !== "GET" || req.url !== "/status") {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ version: 1, pid: process.pid, ...drain.status() }));
  });
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await close();
    throw error;
  }
  return { close };
}

export function requestDrainControl(
  operation: DrainOperation,
  path = controlSocketPath(),
): Promise<DrainStatus> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: path, path: `/${operation}`, method: operation === "status" ? "GET" : "POST" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 4096) req.destroy(new Error("Invalid control response"));
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const status = JSON.parse(body) as DrainStatus;
            if (
              res.statusCode !== 200 ||
              status.version !== 1 ||
              !Number.isSafeInteger(status.pid) ||
              typeof status.draining !== "boolean" ||
              !Number.isSafeInteger(status.activeRequests) ||
              status.activeRequests < 0
            )
              throw new Error("Invalid control response");
            resolve(status);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(3000, () => req.destroy(new Error("Control request timed out")));
    req.on("error", reject);
    req.end();
  });
}
