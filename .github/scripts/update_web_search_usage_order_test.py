from pathlib import Path

p = Path("test/unit/web-search-usage.test.ts")
s = p.read_text()
old = '''    encoder.encode({ type: "response_start", id: "msg_test", model: "test-model" });
    const frames = encoder.encode({
      type: "response_complete",
      finishReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2, webSearchRequests: 1 },
    });

    expect(frames).toContainEqual({
'''
new = '''    const frames = encoder.encode({
      type: "response_start",
      id: "msg_test",
      model: "test-model",
    });
    encoder.encode({
      type: "response_complete",
      finishReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2, webSearchRequests: 1 },
    });

    expect(frames).toContainEqual({
'''
if old not in s:
    raise SystemExit("legacy native Web Search frame assertion anchor not found")
p.write_text(s.replace(old, new, 1))
