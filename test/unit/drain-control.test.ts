import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { RequestDrain } from "../../src/http/request-drain.js";
import { requestDrainControl, startDrainControl } from "../../src/ops/drain-control.js";

describe("local drain control", () => {
  it("freezes admission atomically and releases each request once", () => {
    const drain = new RequestDrain();
    const release = drain.enter();
    drain.begin();
    drain.begin();
    expect(drain.enter()).toBeUndefined();
    expect(drain.status()).toEqual({ draining: true, activeRequests: 1 });
    release?.();
    release?.();
    expect(drain.status()).toEqual({ draining: true, activeRequests: 0 });
    drain.resume();
    expect(drain.enter()).toBeTypeOf("function");
  });

  it("controls drain and resume over a private local socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-control-"));
    const path =
      process.platform === "win32"
        ? `\\\\.\\pipe\\gateway-test-${randomUUID()}`
        : join(directory, "control.sock");
    const drain = new RequestDrain();
    const control = await startDrainControl(drain, path);
    try {
      const release = drain.enter();
      expect(await requestDrainControl("status", path)).toMatchObject({
        version: 1,
        draining: false,
        activeRequests: 1,
      });
      expect(await requestDrainControl("drain", path)).toMatchObject({
        draining: true,
        activeRequests: 1,
      });
      expect(drain.enter()).toBeUndefined();
      release?.();
      expect(await requestDrainControl("status", path)).toMatchObject({
        draining: true,
        activeRequests: 0,
      });
      expect(await requestDrainControl("resume", path)).toMatchObject({ draining: false });
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        await expect(startDrainControl(drain, path)).rejects.toThrow(/Another gateway/);
      }
    } finally {
      await control.close();
      await rm(directory, { recursive: true, force: true });
    }
    await expect(requestDrainControl("status", path)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "does not delete a non-socket file at the control path",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "gateway-control-"));
      const path = join(directory, "control.sock");
      try {
        await writeFile(path, "keep me");
        await expect(startDrainControl(new RequestDrain(), path)).rejects.toThrow(/non-socket/);
        expect(await readFile(path, "utf8")).toBe("keep me");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
