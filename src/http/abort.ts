export interface RawRequestCloseSource {
  aborted: boolean;
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

export interface RawResponseCloseSource {
  writableFinished: boolean;
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

export interface RequestAbortScope {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  dispose(): void;
}

export function createRequestAbortScope(
  request: RawRequestCloseSource,
  response?: RawResponseCloseSource,
  timeoutMs?: number,
): RequestAbortScope {
  const controller = new AbortController();
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(new DOMException("Upstream request timed out", "TimeoutError"));
        }, timeoutMs);
  timer?.unref();
  const onRequestClose = () => {
    if (request.aborted) {
      controller.abort(new Error("Client disconnected"));
    }
  };
  const onResponseClose = () => {
    if (!response?.writableFinished) {
      controller.abort(new Error("Client disconnected"));
    }
  };
  request.on("close", onRequestClose);
  response?.on("close", onResponseClose);

  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    dispose: () => {
      clearTimeout(timer);
      request.off("close", onRequestClose);
      response?.off("close", onResponseClose);
    },
  };
}
