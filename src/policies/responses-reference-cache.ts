import { createHash, createHmac, randomBytes } from "node:crypto";

interface CacheOptions {
  ttlMs?: number;
  maxItemBytes?: number;
  maxCredentialBytes?: number;
  maxBytes?: number;
  maxCredentialEntries?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  owner: string;
  json?: string;
  bytes: number;
  expiresAt: number;
}

const supportedTypes = new Set(["message", "reasoning", "function_call", "web_search_call"]);

export class ResponsesReferenceCache {
  readonly #secret = randomBytes(32);
  readonly #entries = new Map<string, Entry>();
  readonly #owners = new Map<string, { bytes: number; keys: Set<string> }>();
  readonly #options: Required<CacheOptions>;
  #bytes = 0;

  constructor(options: CacheOptions = {}) {
    this.#options = {
      ttlMs: 5 * 60_000,
      maxItemBytes: 1024 * 1024,
      maxCredentialBytes: 4 * 1024 * 1024,
      maxBytes: 32 * 1024 * 1024,
      maxCredentialEntries: 256,
      maxEntries: 2048,
      now: () => performance.now(),
      ...options,
    };
  }

  remember(apiKey: string, model: string, output: readonly unknown[]) {
    this.prune();
    const owner = this.#owner(apiKey);
    let stored = 0;
    let skipped = 0;
    for (const raw of output) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        skipped++;
        continue;
      }
      const item = raw as Record<string, unknown>;
      if (
        typeof item.id !== "string" ||
        item.id.length === 0 ||
        typeof item.type !== "string" ||
        !supportedTypes.has(item.type)
      ) {
        skipped++;
        continue;
      }
      const key = this.#key(owner, model, item.id);
      const json = JSON.stringify(item);
      const existing = this.#entries.get(key);
      if (existing !== undefined) {
        // 重复写入不续期；同一 ID 对应不同内容时保留冲突标记，避免错误回放。
        if (existing.json !== json && existing.json !== undefined) {
          const removedBytes = existing.bytes - (key.length + 256);
          delete existing.json;
          existing.bytes -= removedBytes;
          this.#bytes -= removedBytes;
          const usage = this.#owners.get(owner);
          if (usage) usage.bytes -= removedBytes;
        }
        skipped++;
        continue;
      }
      const bytes = Buffer.byteLength(json) + key.length + 256;
      const limits = this.#options;
      if (bytes > Math.min(limits.maxItemBytes, limits.maxCredentialBytes, limits.maxBytes)) {
        skipped++;
        continue;
      }
      let usage = this.#owners.get(owner);
      while (
        usage &&
        (usage.bytes + bytes > limits.maxCredentialBytes ||
          usage.keys.size >= limits.maxCredentialEntries)
      ) {
        const oldest = usage.keys.values().next().value;
        if (oldest === undefined) break;
        const entry = this.#entries.get(oldest);
        if (entry === undefined) break;
        this.#remove(oldest, entry);
        usage = this.#owners.get(owner);
      }
      while (this.#bytes + bytes > limits.maxBytes || this.#entries.size >= limits.maxEntries) {
        const oldest = this.#entries.entries().next().value;
        if (oldest === undefined) break;
        this.#remove(...oldest);
      }
      this.#insert(key, { owner, json, bytes, expiresAt: limits.now() + limits.ttlMs });
      stored++;
    }
    return { stored, skipped };
  }

  resolve(apiKey: string, model: string, id: string): Record<string, unknown> | undefined {
    const key = this.#key(this.#owner(apiKey), model, id);
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#options.now()) {
      this.#remove(key, entry);
      return undefined;
    }
    return entry.json === undefined
      ? undefined
      : (JSON.parse(entry.json) as Record<string, unknown>);
  }

  prune(): void {
    const now = this.#options.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#remove(key, entry);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#owners.clear();
    this.#bytes = 0;
  }

  #owner(apiKey: string): string {
    return createHmac("sha256", this.#secret).update(apiKey).digest("hex");
  }

  #key(owner: string, model: string, id: string): string {
    return (
      owner +
      ":" +
      createHash("sha256")
        .update(JSON.stringify([model, id]))
        .digest("hex")
    );
  }

  #insert(key: string, entry: Entry): void {
    const usage = this.#owners.get(entry.owner) ?? { bytes: 0, keys: new Set<string>() };
    usage.bytes += entry.bytes;
    usage.keys.add(key);
    this.#owners.set(entry.owner, usage);
    this.#entries.set(key, entry);
    this.#bytes += entry.bytes;
  }

  #remove(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
    const usage = this.#owners.get(entry.owner);
    if (usage === undefined) return;
    usage.bytes -= entry.bytes;
    usage.keys.delete(key);
    if (usage.keys.size === 0) this.#owners.delete(entry.owner);
  }
}
