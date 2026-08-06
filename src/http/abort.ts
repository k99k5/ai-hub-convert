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
): RequestAbortScope {
  const controller = new AbortController();
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
      request.off("close", onRequestClose);
      response?.off("close", onResponseClose);
    },
  };
}
