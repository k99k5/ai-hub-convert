import type { FastifyInstance, FastifyRequest } from "fastify";
import { sendAnthropicError } from "./errors.js";

export const DRAIN_MESSAGE = "Gateway is updating; retry after maintenance completes";
const httpRequests = new WeakMap<FastifyRequest, () => void>();

// Called only by the actual WS upgrade handler, never inferred from a header
// that an ordinary POST client could spoof to bypass request accounting.
export function finishHttpUpgrade(request: FastifyRequest): void {
  httpRequests.get(request)?.();
}

export class RequestDrain {
  #draining = false;
  #active = 0;

  status() {
    return { draining: this.#draining, activeRequests: this.#active };
  }

  begin(): void {
    this.#draining = true;
  }

  resume(): void {
    this.#draining = false;
  }

  // Acquire synchronously before any await/queueing, so drain cannot miss work
  // that has been accepted but has not reached the upstream yet.
  enter(): (() => void) | undefined {
    if (this.#draining) return undefined;
    this.#active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
    };
  }
}

export function registerRequestDrain(app: FastifyInstance, drain: RequestDrain): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    if (path === "/health/live" || path === "/health/ready") return;
    const release = drain.enter();
    if (!release) {
      reply.header("retry-after", "5");
      if (path === "/v1/messages" || path === "/v1/messages/count_tokens") {
        return sendAnthropicError(reply, 503, "overloaded_error", DRAIN_MESSAGE);
      }
      return reply.code(503).send({
        error: { type: "server_error", code: "server_draining", message: DRAIN_MESSAGE },
        request_id: request.id,
      });
    }
    const done = () => {
      httpRequests.delete(request);
      reply.raw.off("finish", done);
      reply.raw.off("close", done);
      release();
    };
    httpRequests.set(request, done);
    reply.raw.once("finish", done);
    reply.raw.once("close", done);
  });
}
