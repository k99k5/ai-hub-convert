from pathlib import Path

p = Path('src/app.ts')
text = p.read_text()

marker = '''function isProtocolAdapterError(error: unknown): boolean {
  return error instanceof OpenAIAdapterError || error instanceof ChatAdapterError;
}

'''
insert = '''function isProtocolAdapterError(error: unknown): boolean {
  return error instanceof OpenAIAdapterError || error instanceof ChatAdapterError;
}

function debugAnthropicBodyShape(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { bodyType: Array.isArray(body) ? "array" : body === null ? "null" : typeof body };
  }
  const record = body as Record<string, unknown>;
  const messages = record.messages;
  const tools = record.tools;
  return {
    keys: Object.keys(record).sort(),
    modelType: typeof record.model,
    maxTokensType: typeof record.max_tokens,
    ...(typeof record.max_tokens === "number" ? { maxTokens: record.max_tokens } : {}),
    messagesType: Array.isArray(messages) ? "array" : typeof messages,
    ...(Array.isArray(messages) ? { messageCount: messages.length } : {}),
    systemType: Array.isArray(record.system) ? "array" : typeof record.system,
    toolsType: Array.isArray(tools) ? "array" : typeof tools,
    ...(Array.isArray(tools) ? { toolCount: tools.length } : {}),
    streamType: typeof record.stream,
    ...(typeof record.stream === "boolean" ? { stream: record.stream } : {}),
  };
}

function debugBoundaryValidation(validation: unknown): unknown {
  if (!Array.isArray(validation)) {
    return validation === undefined ? undefined : { type: typeof validation };
  }
  return validation.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { type: typeof raw };
    }
    const item = raw as Record<string, unknown>;
    const params =
      typeof item.params === "object" && item.params !== null && !Array.isArray(item.params)
        ? (item.params as Record<string, unknown>)
        : undefined;
    return {
      ...(typeof item.instancePath === "string" ? { instancePath: item.instancePath } : {}),
      ...(typeof item.schemaPath === "string" ? { schemaPath: item.schemaPath } : {}),
      ...(typeof item.keyword === "string" ? { keyword: item.keyword } : {}),
      ...(typeof item.message === "string" ? { message: item.message } : {}),
      ...(params?.missingProperty !== undefined
        ? { missingProperty: params.missingProperty }
        : {}),
      ...(params?.additionalProperty !== undefined
        ? { additionalProperty: params.additionalProperty }
        : {}),
    };
  });
}

function debugAnthropic400(
  event: string,
  requestId: string,
  body: unknown,
  details: Record<string, unknown>,
): void {
  process.stderr.write(
    `[web-search-debug] ${JSON.stringify({
      event,
      requestId,
      ...debugAnthropicBodyShape(body),
      ...details,
    })}\\n`,
  );
}

'''
if marker not in text:
    raise RuntimeError('helper marker not found')
text = text.replace(marker, insert, 1)

marker = '''      if (
        boundaryError?.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
        boundaryError?.validation !== undefined
      ) {
        return protocol === "anthropic"
          ? sendAnthropicError(reply, 400, "invalid_request_error", "Invalid request body")
          : sendOpenAIRequestError(reply, 400, "invalid_request", "Invalid request body");
      }
'''
replacement = '''      if (
        boundaryError?.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
        boundaryError?.validation !== undefined
      ) {
        if (protocol === "anthropic") {
          debugAnthropic400("anthropic_boundary_400", request.id, request.body, {
            errorCode: boundaryError?.code,
            validation: debugBoundaryValidation(boundaryError?.validation),
          });
        }
        return protocol === "anthropic"
          ? sendAnthropicError(reply, 400, "invalid_request_error", "Invalid request body")
          : sendOpenAIRequestError(reply, 400, "invalid_request", "Invalid request body");
      }
'''
if marker not in text:
    raise RuntimeError('boundary marker not found')
text = text.replace(marker, replacement, 1)

# Add logging to both AnthropicDecodeError catches. Replace all exact occurrences.
marker = '''          if (error instanceof AnthropicDecodeError) {
            return sendAnthropicError(reply, 400, "invalid_request_error", error.message);
          }
'''
replacement = '''          if (error instanceof AnthropicDecodeError) {
            debugAnthropic400("anthropic_decode_400", request.id, request.body, {
              decodeCode: error.code,
              decodeMessage: error.message,
            });
            return sendAnthropicError(reply, 400, "invalid_request_error", error.message);
          }
'''
count = text.count(marker)
if count < 1:
    raise RuntimeError('decode marker not found')
text = text.replace(marker, replacement)

p.write_text(text)
