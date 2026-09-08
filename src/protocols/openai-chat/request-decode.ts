import type {
  CanonicalRequest,
  CanonicalTool,
  Content,
  Message,
  ToolChoice,
} from "../../core/ir.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../providers/web-search/internal.js";
import {
  type ChatMessageOptions,
  type ChatRequestExtensions,
  type ChatResponseFormat,
  OpenAIAdapterError,
} from "./types.js";

const supportedFields = [
  "model",
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "max_tokens",
  "max_completion_tokens",
  "reasoning_effort",
  "response_format",
  "stream",
  "stream_options",
  "temperature",
  "top_p",
  "stop",
  "n",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "logit_bias",
  "user",
  "safety_identifier",
  "service_tier",
  "metadata",
  "store",
  "prompt_cache_key",
];

function invalid(message: string): never {
  throw new OpenAIAdapterError("INVALID_OPENAI_CHAT_REQUEST", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    invalid("Chat 请求包含不支持的字段");
  }
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    invalid(`${label} 必须是${allowEmpty ? "" : "非空"}字符串`);
  }
  return value;
}

function number(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    invalid(`${label} 必须是 ${min} 到 ${max} 之间的有限数值`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalid(`${label} 必须是布尔值`);
  return value;
}

function decodeContent(
  value: unknown,
  role: Message["role"],
  options: ChatMessageOptions,
): Content[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (role === "assistant" && (value === undefined || value === null)) {
    if (value === null) options.contentNull = true;
    return [];
  }
  if (!Array.isArray(value)) invalid("消息 content 必须是字符串或内容数组");
  return value.map((rawPart, index) => {
    const part = record(rawPart, "消息内容");
    if (part.type === "text") {
      fields(part, ["type", "text"]);
      return { type: "text", text: string(part.text, "text", true) };
    }
    if (part.type === "refusal" && role === "assistant") {
      fields(part, ["type", "refusal"]);
      return { type: "refusal", refusal: string(part.refusal, "refusal", true) };
    }
    if (part.type === "image_url" && role === "user") {
      fields(part, ["type", "image_url"]);
      const image = record(part.image_url, "image_url");
      fields(image, ["url", "detail"]);
      const url = string(image.url, "image_url.url");
      if (image.detail !== undefined) {
        if (image.detail !== "auto" && image.detail !== "low" && image.detail !== "high") {
          invalid("图片 detail 仅支持 auto、low 或 high");
        }
        options.imageDetails ??= [];
        options.imageDetails[index] = image.detail;
      }
      return { type: "image", source: { type: "url", url } };
    }
    return invalid("Chat 不支持此消息内容类型");
  });
}

function decodeMessage(value: unknown, options: ChatMessageOptions): Message {
  const input = record(value, "消息");
  const role = input.role;
  if (role === "tool") {
    fields(input, ["role", "content", "tool_call_id"]);
    const content = decodeContent(input.content, role, options);
    return {
      role,
      content: [
        {
          type: "function_result",
          callId: string(input.tool_call_id, "tool_call_id"),
          output: content.map((part) => (part.type === "text" ? part.text : "")).join(""),
          isError: false,
        },
      ],
    };
  }
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") {
    invalid("Chat 不支持此消息角色");
  }
  fields(
    input,
    role === "assistant"
      ? ["role", "content", "name", "tool_calls", "reasoning_content", "refusal"]
      : ["role", "content", "name"],
  );
  if (input.name !== undefined) options.name = string(input.name, "消息 name");
  const content = decodeContent(input.content, role, options);
  if (role === "assistant") {
    if (input.reasoning_content !== undefined && input.reasoning_content !== null) {
      content.push({
        type: "reasoning",
        text: string(input.reasoning_content, "reasoning_content", true),
        source: "openai-chat",
      });
    }
    if (input.refusal !== undefined && input.refusal !== null) {
      content.push({ type: "refusal", refusal: string(input.refusal, "refusal", true) });
    }
    if (input.tool_calls !== undefined) {
      if (!Array.isArray(input.tool_calls)) invalid("tool_calls 必须是数组");
      for (const rawCall of input.tool_calls) {
        const call = record(rawCall, "工具调用");
        fields(call, ["id", "type", "function"]);
        if (call.type !== "function") invalid("Chat 仅支持函数工具调用");
        const fn = record(call.function, "工具调用 function");
        fields(fn, ["name", "arguments"]);
        const name = toolName(fn.name);
        content.push({
          type: "function_call",
          id: string(call.id, "工具调用 id"),
          name,
          arguments: string(fn.arguments, "工具调用 arguments", true),
        });
      }
    }
  }
  return { role, content };
}

function toolName(value: unknown): string {
  const name = string(value, "函数名称");
  if (name === INTERNAL_WEB_SEARCH_TOOL_NAME) invalid("函数名称与网关保留的搜索工具名称冲突");
  return name;
}

function decodeTools(value: unknown, extensions: ChatRequestExtensions): CanonicalTool[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid("tools 必须是数组");
  const toolStrict: Array<boolean | null | undefined> = [];
  extensions.tool_strict = toolStrict;
  return value.map((rawTool, index) => {
    const tool = record(rawTool, "工具");
    fields(tool, ["type", "function"]);
    if (tool.type !== "function") invalid("Chat 仅支持函数工具，不支持内置搜索");
    const fn = record(tool.function, "工具 function");
    fields(fn, ["name", "description", "parameters", "strict"]);
    const strict = optionalBoolean(fn.strict, "工具 strict");
    toolStrict[index] = fn.strict === null ? null : strict;
    return {
      type: "function",
      name: toolName(fn.name),
      ...(fn.description === undefined
        ? {}
        : { description: string(fn.description, "工具 description", true) }),
      inputSchema: fn.parameters === undefined ? {} : record(fn.parameters, "工具 parameters"),
      strict: strict ?? false,
    };
  });
}

function decodeToolChoice(value: unknown, tools: CanonicalTool[]): ToolChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "none" || value === "required") return { type: value };
  const choice = record(value, "tool_choice");
  fields(choice, ["type", "function"]);
  if (choice.type !== "function") invalid("Chat 不支持此 tool_choice");
  const fn = record(choice.function, "tool_choice.function");
  fields(fn, ["name"]);
  const name = toolName(fn.name);
  if (!tools.some((tool) => tool.type === "function" && tool.name === name)) {
    invalid("tool_choice 必须选择已声明的工具");
  }
  return { type: "function", name };
}

function decodeResponseFormat(value: unknown): ChatResponseFormat | undefined {
  if (value === undefined || value === null) return undefined;
  const format = record(value, "response_format");
  if (format.type === "text" || format.type === "json_object") {
    fields(format, ["type"]);
    return { type: format.type };
  }
  fields(format, ["type", "json_schema"]);
  if (format.type !== "json_schema") invalid("Chat 不支持此 response_format");
  const schema = record(format.json_schema, "response_format.json_schema");
  fields(schema, ["name", "description", "schema", "strict"]);
  const strict = optionalBoolean(schema.strict, "json_schema.strict");
  return {
    type: "json_schema",
    json_schema: {
      name: string(schema.name, "json_schema.name"),
      schema: record(schema.schema, "json_schema.schema"),
      ...(schema.description === undefined
        ? {}
        : { description: string(schema.description, "json_schema.description", true) }),
      ...(schema.strict === null ? { strict: null } : strict === undefined ? {} : { strict }),
    },
  };
}

function decodeExtensions(input: Record<string, unknown>): ChatRequestExtensions {
  const extensions: ChatRequestExtensions = {};
  if (input.prompt_cache_key !== undefined) {
    extensions.prompt_cache_key =
      input.prompt_cache_key === null
        ? null
        : string(input.prompt_cache_key, "prompt_cache_key", true);
  }
  for (const key of ["frequency_penalty", "presence_penalty"] as const) {
    const value = number(input[key], key, -2, 2);
    if (value !== undefined) extensions[key] = value;
  }
  if (input.seed !== undefined && input.seed !== null) {
    const seed = number(input.seed, "seed", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (seed === undefined || !Number.isSafeInteger(seed)) invalid("seed 必须是安全整数");
    extensions.seed = seed;
  }
  if (input.logit_bias !== undefined && input.logit_bias !== null) {
    const bias = record(input.logit_bias, "logit_bias");
    extensions.logit_bias = {};
    for (const [key, value] of Object.entries(bias)) {
      const score = number(value, "logit_bias", -100, 100);
      if (!/^\d+$/.test(key) || score === undefined)
        invalid("logit_bias 必须将词元编号映射到 -100 到 100 的数值");
      extensions.logit_bias[key] = score;
    }
  }
  for (const key of ["user", "safety_identifier"] as const) {
    if (input[key] !== undefined && input[key] !== null)
      extensions[key] = string(input[key], key, true);
  }
  if (input.service_tier !== undefined && input.service_tier !== null) {
    const tier = input.service_tier;
    if (tier !== "auto" && tier !== "default" && tier !== "flex" && tier !== "priority")
      invalid("不支持的 service_tier");
    extensions.service_tier = tier;
  }
  if (input.metadata !== undefined && input.metadata !== null) {
    const metadata = record(input.metadata, "metadata");
    extensions.metadata = Object.fromEntries(
      Object.entries(metadata).map(([key, value]) => [key, string(value, "metadata 值", true)]),
    );
  }
  const store = optionalBoolean(input.store, "store");
  if (store !== undefined) extensions.store = store;
  if (input.stream_options !== undefined && input.stream_options !== null) {
    const options = record(input.stream_options, "stream_options");
    fields(options, ["include_usage"]);
    extensions.stream_options = {
      include_usage: optionalBoolean(options.include_usage, "include_usage") ?? false,
    };
  }
  const effort = input.reasoning_effort;
  if (effort !== undefined) {
    if (
      effort !== null &&
      effort !== "none" &&
      effort !== "minimal" &&
      effort !== "low" &&
      effort !== "medium" &&
      effort !== "high" &&
      effort !== "xhigh" &&
      effort !== "max"
    )
      invalid("不支持的 reasoning_effort");
    extensions.reasoning_effort = effort;
  }
  const responseFormat = decodeResponseFormat(input.response_format);
  if (responseFormat !== undefined) extensions.response_format = responseFormat;
  return extensions;
}

export function decodeChatRequest(value: unknown): CanonicalRequest {
  const input = record(value, "Chat 请求体");
  fields(input, supportedFields);
  if (input.n !== undefined && input.n !== null && input.n !== 1)
    invalid("Chat 仅支持 n=1 的单候选答案");
  if (input.max_tokens !== undefined && input.max_completion_tokens !== undefined)
    invalid("max_tokens 与 max_completion_tokens 不能同时提供");
  const maxOutputTokens = number(
    input.max_tokens ?? input.max_completion_tokens,
    "最大输出词元数",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (maxOutputTokens !== undefined && !Number.isSafeInteger(maxOutputTokens))
    invalid("最大输出词元数必须是正整数");
  if (!Array.isArray(input.messages) || input.messages.length === 0)
    invalid("messages 必须是非空数组");
  const extensions = decodeExtensions(input);
  const messageOptions: ChatMessageOptions[] = [];
  const messages = input.messages.map((message) => {
    const options: ChatMessageOptions = {};
    messageOptions.push(options);
    return decodeMessage(message, options);
  });
  if (messageOptions.some((options) => Object.keys(options).length > 0))
    extensions.message_options = messageOptions;
  if (input.max_tokens !== undefined && maxOutputTokens !== undefined)
    extensions.max_tokens = maxOutputTokens;
  const tools = decodeTools(input.tools, extensions);
  const toolChoice = decodeToolChoice(input.tool_choice, tools);
  const temperature = number(input.temperature, "temperature", 0, 2);
  const topP = number(input.top_p, "top_p", 0, 1);
  const parallelToolCalls = optionalBoolean(input.parallel_tool_calls, "parallel_tool_calls");
  const stream = optionalBoolean(input.stream, "stream") ?? false;
  let stopSequences: string[] | undefined;
  if (input.stop !== undefined && input.stop !== null) {
    stopSequences =
      typeof input.stop === "string"
        ? [input.stop]
        : Array.isArray(input.stop)
          ? input.stop.map((stop) => string(stop, "stop", true))
          : invalid("stop 必须是字符串或字符串数组");
    if (stopSequences.length > 4) invalid("stop 最多包含 4 个字符串");
  }
  const effort = extensions.reasoning_effort;
  return {
    source: "openai-chat",
    model: string(input.model, "model"),
    messages,
    tools,
    stream,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(stopSequences === undefined ? {} : { stopSequences }),
    ...(effort === undefined || effort === "none" || effort === "minimal"
      ? {}
      : { reasoningEffort: effort }),
    ...(extensions.response_format?.type === "json_schema"
      ? {
          outputFormat: {
            type: "json_schema" as const,
            schema: extensions.response_format.json_schema.schema,
          },
        }
      : {}),
    ...(Object.keys(extensions).length === 0
      ? {}
      : { extensions: { source: "openai-chat", request: { ...extensions } } }),
  };
}
