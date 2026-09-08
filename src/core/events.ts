import type {
  CanonicalResponse,
  Citation,
  Content,
  FinishReason,
  OpaqueContinuation,
  ProviderExtensions,
  Usage,
} from "./ir.js";

export type CanonicalEvent =
  | {
      type: "response_start";
      id: string;
      model: string;
      usage?: Usage;
      extensions?: ProviderExtensions;
    }
  | { type: "content_start"; index: number; itemId?: string; content: Content }
  | { type: "text_delta"; index: number; delta: string }
  | { type: "reasoning_delta"; index: number; delta: string }
  | { type: "reasoning_continuation"; index: number; opaque: OpaqueContinuation }
  | { type: "signature_delta"; index: number; delta: string }
  | { type: "function_arguments_delta"; index: number; delta: string }
  | { type: "citation_delta"; index: number; citation: Citation }
  | { type: "content_stop"; index: number }
  | { type: "web_search_start"; id: string; query: string }
  | {
      type: "web_search_result";
      execution: {
        id: string;
        query: string;
        results: Array<{ title: string; url: string; content: string }>;
      };
    }
  | {
      type: "response_complete";
      finishReason: FinishReason;
      usage: Usage;
      stopSequence?: string;
      extensions?: ProviderExtensions;
    }
  | { type: "response_error"; error: CanonicalError };

export interface CanonicalError {
  status: number;
  code: string;
  message: string;
  requestId?: string;
  retryable: boolean;
}

export function foldCanonicalEvents(events: readonly CanonicalEvent[]): CanonicalResponse {
  const start = events.find((event) => event.type === "response_start");
  const complete = events.findLast((event) => event.type === "response_complete");
  if (
    !start ||
    start.type !== "response_start" ||
    !complete ||
    complete.type !== "response_complete"
  ) {
    throw new Error("Canonical event stream is incomplete");
  }

  const contentByIndex = new Map<number, Content>();
  for (const event of events) {
    if (event.type === "content_start") {
      contentByIndex.set(event.index, structuredClone(event.content));
      continue;
    }
    const content = "index" in event ? contentByIndex.get(event.index) : undefined;
    if (!content) {
      continue;
    }
    if (event.type === "text_delta" && content.type === "text") {
      content.text += event.delta;
    } else if (event.type === "text_delta" && content.type === "refusal") {
      content.refusal += event.delta;
    } else if (event.type === "reasoning_delta" && content.type === "reasoning") {
      content.text += event.delta;
    } else if (event.type === "reasoning_continuation" && content.type === "reasoning") {
      content.opaque = structuredClone(event.opaque);
    } else if (event.type === "signature_delta" && content.type === "reasoning") {
      content.signature = (content.signature ?? "") + event.delta;
    } else if (event.type === "function_arguments_delta" && content.type === "function_call") {
      content.arguments += event.delta;
    } else if (event.type === "citation_delta" && content.type === "text") {
      content.citations = [...(content.citations ?? []), event.citation];
    }
  }

  return {
    id: start.id,
    model: start.model,
    content: [...contentByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, content]) => content),
    finishReason: complete.finishReason,
    ...(complete.stopSequence ? { stopSequence: complete.stopSequence } : {}),
    usage: complete.usage,
    ...((complete.extensions ?? start.extensions)
      ? { extensions: complete.extensions ?? start.extensions }
      : {}),
  };
}
