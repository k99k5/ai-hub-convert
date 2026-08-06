import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createRequestAbortScope } from "../../src/http/abort.js";

class RawRequest extends EventEmitter {
  aborted = false;
}

class RawResponse extends EventEmitter {
  writableFinished = false;
}

describe("createRequestAbortScope", () => {
  it("aborts when the client disconnects", () => {
    const request = new RawRequest();
    const scope = createRequestAbortScope(request);

    request.aborted = true;
    request.emit("close");

    expect(scope.signal.aborted).toBe(true);
  });

  it("does not abort for a normal request close", () => {
    const request = new RawRequest();
    const scope = createRequestAbortScope(request);

    request.emit("close");

    expect(scope.signal.aborted).toBe(false);
    scope.dispose();
  });

  it("aborts when the response connection closes before completion", () => {
    const request = new RawRequest();
    const response = new RawResponse();
    const scope = createRequestAbortScope(request, response);

    response.emit("close");

    expect(scope.signal.aborted).toBe(true);
  });

  it("does not abort after a response finishes normally", () => {
    const request = new RawRequest();
    const response = new RawResponse();
    const scope = createRequestAbortScope(request, response);

    response.writableFinished = true;
    response.emit("close");

    expect(scope.signal.aborted).toBe(false);
    scope.dispose();
  });
});
