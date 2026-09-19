import { createHmac, randomBytes, randomUUID } from "node:crypto";

export type ConversationItem = Record<string, unknown> & { id: string };
export interface Conversation {
  id: string;
  object: "conversation";
  created_at: number;
  metadata: Record<string, string>;
}
interface Document extends Conversation {
  items: ConversationItem[];
}
interface Entry {
  owner: string;
  json: string;
  bytes: number;
  busy: boolean;
}
interface StoreOptions {
  maxConversationBytes?: number;
  maxCredentialBytes?: number;
  maxBytes?: number;
  maxCredentialEntries?: number;
  maxEntries?: number;
  maxItems?: number;
}

export class ConversationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 429,
    readonly code: string,
    message: string,
    readonly param = "conversation",
  ) {
    super(message);
  }
}

export interface ConversationTurn {
  readonly id: string;
  readonly input: ConversationItem[];
  stage(input: ConversationItem[]): void;
  commit(output: ConversationItem[]): void;
  release(): void;
}

// Only serialized conversation data is retained. Credentials are HMAC-scoped,
// and capacity failures never evict or truncate another conversation.
export class ConversationStore {
  readonly #secret = randomBytes(32);
  readonly #entries = new Map<string, Entry>();
  readonly #options: Required<StoreOptions>;
  #bytes = 0;

  constructor(options: StoreOptions = {}) {
    this.#options = {
      maxConversationBytes: 32 * 1024 * 1024,
      maxCredentialBytes: 32 * 1024 * 1024,
      maxBytes: 128 * 1024 * 1024,
      maxCredentialEntries: 128,
      maxEntries: 1024,
      maxItems: 4096,
      ...options,
    };
    for (const [name, value] of Object.entries(this.#options)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Conversation store ${name} must be a positive safe integer`);
      }
    }
  }

  create(
    apiKey: string,
    metadata: Record<string, string>,
    items: ConversationItem[],
  ): Conversation {
    const document: Document = {
      id: `conv_${randomUUID()}`,
      object: "conversation",
      created_at: Math.floor(Date.now() / 1000),
      metadata,
      items,
    };
    const owner = this.#owner(apiKey);
    const key = this.#key(owner, document.id);
    const owned = [...this.#entries.values()].filter((entry) => entry.owner === owner);
    if (
      owned.length >= this.#options.maxCredentialEntries ||
      this.#entries.size >= this.#options.maxEntries
    ) {
      throw new ConversationError(
        429,
        "conversation_capacity_exceeded",
        "Conversation capacity reached; delete an unused conversation",
      );
    }
    const entry: Entry = { owner, json: "", bytes: 0, busy: false };
    this.#write(key, entry, document);
    return this.#resource(document);
  }

  retrieve(apiKey: string, id: string): Conversation {
    return this.#resource(this.#document(this.#get(apiKey, id).entry));
  }

  update(apiKey: string, id: string, metadata: Record<string, string> | undefined): Conversation {
    const { key, entry } = this.#get(apiKey, id);
    this.#assertIdle(entry);
    const document = this.#document(entry);
    if (metadata !== undefined) document.metadata = metadata;
    this.#write(key, entry, document);
    return this.#resource(document);
  }

  delete(
    apiKey: string,
    id: string,
  ): { id: string; object: "conversation.deleted"; deleted: true } {
    const { key, entry } = this.#get(apiKey, id);
    this.#assertIdle(entry);
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
    return { id, object: "conversation.deleted", deleted: true };
  }

  items(apiKey: string, id: string): ConversationItem[] {
    return this.#document(this.#get(apiKey, id).entry).items;
  }

  append(apiKey: string, id: string, items: ConversationItem[]): void {
    const { key, entry } = this.#get(apiKey, id);
    this.#assertIdle(entry);
    const document = this.#document(entry);
    document.items.push(...items);
    this.#write(key, entry, document);
  }

  deleteItem(apiKey: string, id: string, itemId: string): Conversation {
    const { key, entry } = this.#get(apiKey, id);
    this.#assertIdle(entry);
    const document = this.#document(entry);
    const index = document.items.findIndex((item) => item.id === itemId);
    if (index < 0)
      throw new ConversationError(
        404,
        "item_not_found",
        "Conversation item was not found",
        "item_id",
      );
    document.items.splice(index, 1);
    this.#write(key, entry, document);
    return this.#resource(document);
  }

  begin(apiKey: string, id: string): ConversationTurn {
    const { key, entry } = this.#get(apiKey, id);
    this.#assertIdle(entry);
    entry.busy = true;
    const document = this.#document(entry);
    let pending: ConversationItem[] = [];
    let closed = false;
    let committed = false;
    const assertActive = () => {
      if (closed || this.#entries.get(key) !== entry || committed) {
        throw new ConversationError(
          409,
          "conversation_conflict",
          "Conversation turn is no longer active",
        );
      }
    };
    return {
      id,
      input: structuredClone(document.items),
      stage: (input) => {
        assertActive();
        pending = structuredClone(input);
        this.#serialize(key, entry, { ...document, items: [...document.items, ...pending] });
      },
      commit: (output) => {
        assertActive();
        this.#write(key, entry, { ...document, items: [...document.items, ...pending, ...output] });
        committed = true;
      },
      release: () => {
        if (closed) return;
        closed = true;
        entry.busy = false;
      },
    };
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  #serialize(key: string, entry: Entry, document: Document): { json: string; bytes: number } {
    if (document.items.length > this.#options.maxItems) {
      throw new ConversationError(
        413,
        "conversation_too_large",
        "Conversation item limit reached; start a new conversation",
      );
    }
    const ids = new Set(document.items.map((item) => item.id));
    if (ids.size !== document.items.length) {
      throw new ConversationError(
        400,
        "duplicate_item_id",
        "Conversation item IDs must be unique",
        "items",
      );
    }
    const json = JSON.stringify(document);
    const bytes = Buffer.byteLength(json) + key.length + 256;
    if (bytes > this.#options.maxConversationBytes) {
      throw new ConversationError(
        413,
        "conversation_too_large",
        "Conversation exceeds its size limit; start a new conversation",
      );
    }
    const ownerBytes = [...this.#entries.values()].reduce(
      (sum, value) => sum + (value.owner === entry.owner ? value.bytes : 0),
      0,
    );
    if (
      ownerBytes - entry.bytes + bytes > this.#options.maxCredentialBytes ||
      this.#bytes - entry.bytes + bytes > this.#options.maxBytes
    ) {
      throw new ConversationError(
        429,
        "conversation_capacity_exceeded",
        "Conversation capacity reached; delete an unused conversation",
      );
    }
    return { json, bytes };
  }

  #write(key: string, entry: Entry, document: Document): void {
    const { json, bytes } = this.#serialize(key, entry, document);
    this.#bytes += bytes - entry.bytes;
    entry.json = json;
    entry.bytes = bytes;
    this.#entries.set(key, entry);
  }

  #get(apiKey: string, id: string): { key: string; entry: Entry } {
    const key = this.#key(this.#owner(apiKey), id);
    const entry = this.#entries.get(key);
    if (!entry)
      throw new ConversationError(
        404,
        "conversation_not_found",
        "Conversation was not found or is no longer available",
      );
    return { key, entry };
  }

  #assertIdle(entry: Entry): void {
    if (entry.busy)
      throw new ConversationError(
        409,
        "conversation_busy",
        "Wait for the active response to finish before modifying this conversation",
      );
  }

  #document(entry: Entry): Document {
    return JSON.parse(entry.json) as Document;
  }

  #resource({ items: _items, ...conversation }: Document): Conversation {
    return structuredClone(conversation);
  }

  #owner(apiKey: string): string {
    return createHmac("sha256", this.#secret).update(apiKey).digest("hex");
  }

  #key(owner: string, id: string): string {
    return `${owner}:${createHmac("sha256", this.#secret).update(id).digest("hex")}`;
  }
}
