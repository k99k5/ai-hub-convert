import { createHash, createHmac, randomBytes } from "node:crypto";

interface HistoryCacheOptions {
  ttlMs?: number;
  maxEntryBytes?: number;
  maxCredentialBytes?: number;
  maxBytes?: number;
  maxCredentialEntries?: number;
  maxEntries?: number;
  now?: () => number;
}

interface HistoryEntry {
  owner: string;
  json?: string;
  bytes: number;
  expiresAt: number;
}

// Each entry is a complete input/output snapshot, so eviction of an ancestor
// cannot silently truncate a surviving descendant or another conversation fork.
export class ResponsesHistoryCache {
  readonly #secret = randomBytes(32);
  readonly #entries = new Map<string, HistoryEntry>();
  readonly #options: Required<HistoryCacheOptions>;
  #bytes = 0;

  constructor(options: HistoryCacheOptions = {}) {
    this.#options = {
      ttlMs: 5 * 60_000,
      maxEntryBytes: 32 * 1024 * 1024,
      maxCredentialBytes: 32 * 1024 * 1024,
      maxBytes: 128 * 1024 * 1024,
      maxCredentialEntries: 128,
      maxEntries: 1024,
      now: () => performance.now(),
      ...options,
    };
    for (const [name, value] of Object.entries(this.#options)) {
      if (name !== "now" && (!Number.isSafeInteger(value) || (value as number) < 1)) {
        throw new Error(`History cache ${name} must be a positive safe integer`);
      }
    }
  }

  remember(apiKey: string, model: string, id: string, input: readonly unknown[]): boolean {
    if (id.length === 0) return false;
    this.prune();
    const owner = this.#owner(apiKey);
    const key = this.#key(owner, model, id);
    const json = JSON.stringify(input);
    const overhead = key.length + 256;
    const bytes = Buffer.byteLength(json) + overhead;
    const existing = this.#entries.get(key);
    if (existing) {
      // Conflicting upstream IDs must never replay the wrong conversation.
      // Keep a bounded tombstone until its original expiry instead of replacing it.
      if (existing.json !== undefined && existing.json !== json) {
        this.#bytes -= existing.bytes - overhead;
        existing.bytes = overhead;
        delete existing.json;
      }
      return existing.json === json;
    }
    const limits = this.#options;
    if (bytes > Math.min(limits.maxEntryBytes, limits.maxCredentialBytes, limits.maxBytes)) {
      return false;
    }
    const owned = [...this.#entries].filter(([, entry]) => entry.owner === owner);
    let ownerBytes = owned.reduce((total, [, entry]) => total + entry.bytes, 0);
    let ownerEntries = owned.length;
    for (const [oldKey, entry] of owned) {
      if (
        ownerBytes + bytes <= limits.maxCredentialBytes &&
        ownerEntries < limits.maxCredentialEntries
      )
        break;
      ownerBytes -= entry.bytes;
      ownerEntries--;
      this.#remove(oldKey, entry);
    }
    while (this.#bytes + bytes > limits.maxBytes || this.#entries.size >= limits.maxEntries) {
      const oldest = this.#entries.entries().next().value;
      if (!oldest) break;
      this.#remove(...oldest);
    }
    this.#entries.set(key, { owner, json, bytes, expiresAt: limits.now() + limits.ttlMs });
    this.#bytes += bytes;
    return true;
  }

  resolve(apiKey: string, model: string, id: string): unknown[] | undefined {
    const key = this.#key(this.#owner(apiKey), model, id);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#options.now()) {
      this.#remove(key, entry);
      return undefined;
    }
    return entry.json === undefined ? undefined : (JSON.parse(entry.json) as unknown[]);
  }

  prune(): void {
    const now = this.#options.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#remove(key, entry);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  #owner(apiKey: string): string {
    return createHmac("sha256", this.#secret).update(apiKey).digest("hex");
  }

  #key(owner: string, model: string, id: string): string {
    return `${owner}:${createHash("sha256")
      .update(JSON.stringify([model, id]))
      .digest("hex")}`;
  }

  #remove(key: string, entry: HistoryEntry): void {
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }
}
