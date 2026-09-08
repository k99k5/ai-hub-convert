import type { CanonicalEvent } from "../../core/events.js";
import type { Content } from "../../core/ir.js";
import {
  chatCreated,
  chatResponseMetadata,
  encodeChatFinishReason,
  encodeChatUsage,
} from "./response-encode.js";

export interface ChatSseFrame {
  data: Record<string, unknown> | string;
}

interface ContentState {
  type: "text" | "refusal" | "reasoning" | "function_call";
  toolIndex?: number;
  open: boolean;
}

export class ChatStreamEncoder {
  #identity?: { id: string; model: string; created: number };
  #completed = false;
  #toolCount = 0;
  readonly #content = new Map<number, ContentState>();

  constructor(private readonly options: { includeUsage?: boolean } = {}) {}

  encode(event: CanonicalEvent): ChatSseFrame[] {
    if (this.#completed) throw new Error("Chat 响应流已经结束");
    switch (event.type) {
      case "response_start":
        if (this.#identity) throw new Error("Chat 响应流已经开始");
        this.#identity = {
          id: event.id,
          model: event.model,
          created: chatCreated(chatResponseMetadata(event.extensions)),
        };
        return [this.#chunk({ role: "assistant", content: "" })];
      case "content_start":
        return this.#startContent(event.index, event.content);
      case "text_delta": {
        const state = this.#openContent(event.index);
        if (state.type !== "text" && state.type !== "refusal")
          throw new Error("Chat 文本增量与内容类型不匹配");
        return [this.#chunk({ [state.type === "refusal" ? "refusal" : "content"]: event.delta })];
      }
      case "reasoning_delta":
        if (this.#openContent(event.index).type !== "reasoning")
          throw new Error("Chat 推理增量与内容类型不匹配");
        return [this.#chunk({ reasoning_content: event.delta })];
      case "function_arguments_delta": {
        const state = this.#openContent(event.index);
        if (state.type !== "function_call") throw new Error("Chat 工具参数增量与内容类型不匹配");
        return [
          this.#chunk({
            tool_calls: [{ index: state.toolIndex, function: { arguments: event.delta } }],
          }),
        ];
      }
      case "content_stop":
        this.#openContent(event.index).open = false;
        return [];
      case "response_complete": {
        this.#assertStarted();
        if ([...this.#content.values()].some((state) => state.open))
          throw new Error("Chat 响应仍有未结束的内容");
        const metadata = chatResponseMetadata(event.extensions);
        const frames = [
          this.#chunk({}, encodeChatFinishReason(event.finishReason, metadata.finish_reason)),
        ];
        if (this.options.includeUsage) {
          frames.push({
            data: {
              ...this.#identity,
              object: "chat.completion.chunk",
              choices: [],
              usage: encodeChatUsage(event.usage),
            },
          });
        }
        frames.push({ data: "[DONE]" });
        this.#completed = true;
        return frames;
      }
      case "response_error":
        this.#completed = true;
        return [
          {
            data: {
              error: {
                type: "api_error",
                code: "upstream_stream_error",
                message: "上游 Chat 流响应失败",
                param: null,
              },
              ...(event.error.requestId === undefined ? {} : { request_id: event.error.requestId }),
            },
          },
        ];
      case "citation_delta":
      case "reasoning_continuation":
      case "signature_delta":
      case "web_search_start":
      case "web_search_result":
        throw new Error(`Chat 响应流不支持事件：${event.type}`);
    }
  }

  #startContent(index: number, content: Content): ChatSseFrame[] {
    this.#assertStarted();
    if (this.#content.has(index)) throw new Error("Chat 响应内容索引重复");
    switch (content.type) {
      case "text":
      case "refusal":
      case "reasoning": {
        this.#content.set(index, { type: content.type, open: true });
        const value = content.type === "refusal" ? content.refusal : content.text;
        const field =
          content.type === "refusal"
            ? "refusal"
            : content.type === "reasoning"
              ? "reasoning_content"
              : "content";
        return value.length === 0 ? [] : [this.#chunk({ [field]: value })];
      }
      case "function_call": {
        const toolIndex = this.#toolCount++;
        this.#content.set(index, { type: content.type, toolIndex, open: true });
        return [
          this.#chunk({
            tool_calls: [
              {
                index: toolIndex,
                id: content.id,
                type: "function",
                function: { name: content.name, arguments: content.arguments },
              },
            ],
          }),
        ];
      }
      default:
        throw new Error(`Chat 响应流不支持内容类型：${content.type}`);
    }
  }

  #openContent(index: number): ContentState {
    const state = this.#content.get(index);
    if (!state?.open) throw new Error("Chat 响应内容尚未开始或已经结束");
    return state;
  }

  #assertStarted(): void {
    if (!this.#identity) throw new Error("Chat 响应流尚未开始");
  }

  #chunk(delta: Record<string, unknown>, finishReason: string | null = null): ChatSseFrame {
    this.#assertStarted();
    return {
      data: {
        ...this.#identity,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
        ...(this.options.includeUsage ? { usage: null } : {}),
      },
    };
  }
}
