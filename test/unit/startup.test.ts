import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each([
  "dev",
  "start",
])("loads .env through the %s command and preserves explicit environment variables", (mode) => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-env-test-"));
  const file = join(directory, ".env");
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const command: string[] = manifest.scripts[mode].split(" ");
  const flags = mode === "dev" ? command.slice(2, -1) : command.slice(1, -1);
  const script = "console.log(process.env.UPSTREAM_BASE_URL);";
  const env = { ...process.env };
  delete env.UPSTREAM_BASE_URL;
  try {
    writeFileSync(file, "UPSTREAM_BASE_URL=https://from-env-file.test/v1\n");
    // tsx forwards these Node flags; test their .env behavior without starting a watcher.
    const args = [...flags, "--input-type=module", "-e", script];
    const run = (environment: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, args, {
        cwd: directory,
        env: environment,
        encoding: "utf8",
        timeout: 5000,
      });
    const fromFile = run(env);
    expect(fromFile.status, fromFile.stderr).toBe(0);
    expect(fromFile.stdout.trim()).toBe("https://from-env-file.test/v1");
    const explicit = run({ ...env, UPSTREAM_BASE_URL: "https://explicit.test/v1" });
    expect(explicit.status, explicit.stderr).toBe(0);
    expect(explicit.stdout.trim()).toBe("https://explicit.test/v1");
    unlinkSync(file);
    expect(run({ ...env, UPSTREAM_BASE_URL: "https://explicit.test/v1" }).status).toBe(0);
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* The optional-file case already removed it. */
    }
    rmdirSync(directory);
  }
});
