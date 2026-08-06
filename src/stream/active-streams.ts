interface AbortableStream {
  abort(reason?: unknown): void;
}

export class ActiveStreamRegistry {
  readonly #controllers = new Set<AbortableStream>();

  get size(): number {
    return this.#controllers.size;
  }

  add(controller: AbortableStream): () => void {
    this.#controllers.add(controller);
    return () => {
      this.#controllers.delete(controller);
    };
  }

  abortAll(): void {
    for (const controller of this.#controllers) {
      controller.abort(new Error("Server is shutting down"));
    }
    this.#controllers.clear();
  }
}
