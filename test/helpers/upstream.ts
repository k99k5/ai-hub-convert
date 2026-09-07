type Wire = Record<string, unknown>;

export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

export function responsesFrames(response: Wire): string[] {
  let sequence = 0;
  const frame = (type: string, fields: Wire) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`;
  const frames = [
    frame("response.created", { response: { id: response.id, model: response.model } }),
  ];
  const output = ((response.output as Wire[]) ?? []).map((raw, index) => {
    const item = { ...raw, id: raw.id ?? `item_${index}` };
    const identity = { output_index: index, item_id: item.id };
    if (raw.type === "message") {
      const content = (raw.content as Wire[]).map((part) =>
        part.type === "output_text" ? { ...part, annotations: part.annotations ?? [] } : part,
      );
      frames.push(
        frame("response.output_item.added", {
          output_index: index,
          item: { ...item, content: [] },
        }),
      );
      content.forEach((part, contentIndex) => {
        const fields = { ...identity, content_index: contentIndex };
        frames.push(
          frame("response.content_part.added", {
            ...fields,
            part: { ...part, text: "", refusal: "" },
          }),
        );
        if (part.type === "output_text") {
          frames.push(frame("response.output_text.delta", { ...fields, delta: part.text }));
          (part.annotations as Wire[]).forEach((annotation, annotationIndex) => {
            frames.push(
              frame("response.output_text.annotation.added", {
                ...fields,
                annotation_index: annotationIndex,
                annotation,
              }),
            );
          });
        } else if (part.type === "refusal") {
          frames.push(frame("response.refusal.delta", { ...fields, delta: part.refusal }));
          frames.push(frame("response.refusal.done", { ...fields, refusal: part.refusal }));
        }
      });
      Object.assign(item, { content });
    } else if (raw.type === "function_call") {
      frames.push(
        frame("response.output_item.added", {
          output_index: index,
          item: { ...item, arguments: "" },
        }),
      );
      frames.push(
        frame("response.function_call_arguments.delta", { ...identity, delta: raw.arguments }),
      );
    } else if (raw.type === "reasoning") {
      frames.push(
        frame("response.output_item.added", {
          output_index: index,
          item: { ...item, summary: [] },
        }),
      );
      for (const part of raw.summary as Wire[]) {
        frames.push(
          frame("response.reasoning_summary_text.delta", {
            ...identity,
            summary_index: 0,
            delta: part.text,
          }),
        );
      }
    }
    frames.push(frame("response.output_item.done", { output_index: index, item }));
    return item;
  });
  frames.push(
    frame(response.status === "incomplete" ? "response.incomplete" : "response.completed", {
      response: { ...response, output },
    }),
    "data: [DONE]\n\n",
  );
  return frames;
}

export function responsesStream(response: Wire): Response {
  return new Response(responsesFrames(response).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

export function chatStream(response: Wire): Response {
  const choices = response.choices as Wire[];
  const choice = choices[0] as Wire;
  const message = choice.message as Wire;
  const calls = message.tool_calls as Wire[] | undefined;
  const payload = {
    ...response,
    choices: [
      {
        index: 0,
        finish_reason: choice.finish_reason,
        delta: {
          ...message,
          ...(calls === undefined
            ? {}
            : { tool_calls: calls.map((call, index) => ({ ...call, index })) }),
        },
      },
    ],
  };
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}
