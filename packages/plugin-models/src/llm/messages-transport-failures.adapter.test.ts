import { describe, expect, test } from "bun:test"
import { Effect, Option, Redacted, Stream } from "effect"
import { Prompt } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { CurrentModelCallPolicy, modelFailureOf, parseModelSelection } from "@xandreed/core"
import { CurrentModelCallPurpose } from "../ports/model-call-completion.port.js"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import { CurrentModelRetryPolicy } from "../ports/model-retry-policy.port.js"
import { modelRetryDefaults } from "./model-retry-policy.entity.js"
import { buildProvider } from "./providers.js"

const sse = (event: Record<string, unknown>) => new TextEncoder().encode(`event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`)
const started = (model: unknown) => sse({ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } } })

/** A Messages server whose stream sends `message_start`, then stalls or loses its connection. */
const failingServer = (failure: "stall" | "reset") => {
  const sends: Array<Record<string, unknown>> = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: async (request) => {
    const body = await request.json() as Record<string, unknown>
    sends.push(body)
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(started(body["model"]))
      if (failure === "reset") setTimeout(() => server.stop(true), 40)
    } }), { headers: { "content-type": "text/event-stream" } })
  } })
  return { sends, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const streamOnce = (url: string, model: string) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const selection = yield* Effect.fromOption(parseModelSelection(`gateway:${model}`))
  const built = yield* buildProvider(selection, undefined, Redacted.make("fixture-key"))
  return yield* Effect.flip(Stream.runDrain(built.svc.streamText({ prompt: "Stream a reply." })))
})).pipe(
  Effect.provideService(CurrentModelEndpoints, { gateway: { api: "anthropic-messages", url } }),
  Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "high", maxOutputTokens: 64 })),
  Effect.provideService(CurrentModelRetryPolicy, { ...modelRetryDefaults, requestTimeoutMs: 2000, bodyIdleTimeoutMs: 150, totalTimeoutMs: 5000 }),
  Effect.provide(FetchHttpClient.layer),
))

// claude-opus-4-7 does not bind its thinking; claude-opus-5-5 does, so its stream is observed for dropped thinking blocks.
const models = ["claude-opus-4-7", "claude-opus-5-5"] as const

describe("Messages body failures after handoff keep their kind", () => {
  models.forEach((model) => test(`${model}: a stalled stream is an owned timeout, never an invalid response`, async () => {
    const server = failingServer("stall")
    const failure = await streamOnce(server.url, model).finally(server.stop)
    expect(modelFailureOf(failure)).toEqual(Option.some("Timeout"))
    expect(server.sends).toHaveLength(1)
  }))

  models.forEach((model) => test(`${model}: a stream that loses its connection is a transient failure, never a permanent invalid response`, async () => {
    const server = failingServer("reset")
    const failure = await streamOnce(server.url, model).finally(server.stop)
    expect(modelFailureOf(failure)).toEqual(Option.some("Transient"))
    expect(server.sends).toHaveLength(1)
  }))
})

describe("pending headers are bounded by what the request is", () => {
  const silent = () => {
    const sends: Array<number> = []
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: () => {
      sends.push(Date.now())
      return new Promise<Response>(() => undefined)
    } })
    // Not awaited: a handler that never answers would hold a graceful stop open.
    return { sends, url: `http://127.0.0.1:${server.port}`, stop: () => { void server.stop(true) } }
  }
  const call = (url: string, mode: "stream" | "settled") => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const selection = yield* Effect.fromOption(parseModelSelection("gateway:claude-opus-4-7"))
    const built = yield* buildProvider(selection, undefined, Redacted.make("fixture-key"))
    return yield* Effect.flip(mode === "stream" ? Stream.runDrain(built.svc.streamText({ prompt: "Stream a reply." })) : built.svc.generateText({ prompt: "Settle a reply." }).pipe(Effect.asVoid))
  })).pipe(
    Effect.provideService(CurrentModelEndpoints, { gateway: { api: "anthropic-messages", url } }),
    Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "high", maxOutputTokens: 64 })),
    Effect.provideService(CurrentModelRetryPolicy, { ...modelRetryDefaults, maxAttempts: 2, requestTimeoutMs: 80, totalTimeoutMs: 600, backoff: { initialMs: 0, maxMs: 0, jitter: 0 } }),
    Effect.provide(FetchHttpClient.layer),
  ))

  test("a streamed request's headers time out at requestTimeoutMs and are sent again", async () => {
    const server = silent()
    const failure = await call(server.url, "stream").finally(server.stop)
    expect(modelFailureOf(failure)).toEqual(Option.some("Timeout"))
    expect(server.sends).toHaveLength(2)
    expect((server.sends[1] ?? 0) - (server.sends[0] ?? 0)).toBeLessThan(400)
  })

  test("a settled request's headers wait for the deadline and are never sent again: that would generate the response twice", async () => {
    const server = silent()
    const failure = await call(server.url, "settled").finally(server.stop)
    expect(modelFailureOf(failure)).toEqual(Option.some("Timeout"))
    expect(server.sends).toHaveLength(1)
  })
})

describe("helper completions place no automatic prompt-cache breakpoint", () => {
  const cacheMarkers = (body: Record<string, unknown>): number => JSON.stringify(body).split("\"cache_control\":{").length - 1
  const reply = (model: unknown) => Response.json({ id: "msg_fixture", type: "message", role: "assistant", model, content: [{ type: "text", text: "Fixture title." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } })
  const ask = (purpose: "Loop" | "Helper") => {
    const bodies: Array<Record<string, unknown>> = []
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
      const body = await request.json() as Record<string, unknown>
      bodies.push(body)
      return reply(body["model"])
    } })
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection("gateway:claude-opus-5-5"))
      const built = yield* buildProvider(selection, undefined, Redacted.make("fixture-key"))
      yield* built.svc.generateText({ prompt: Prompt.make("Title this conversation: a long transcript.") })
    })).pipe(
      Effect.provideService(CurrentModelCallPurpose, purpose),
      Effect.provideService(CurrentModelEndpoints, { gateway: { api: "anthropic-messages", url: `http://127.0.0.1:${server.port}` } }),
      Effect.provide(FetchHttpClient.layer),
    )).finally(() => server.stop(true)).then(() => bodies)
  }

  test("a helper's one-shot prompt pays no cache-write premium; a loop call keeps its automatic breakpoint", async () => {
    const [loop] = await ask("Loop")
    const [helper] = await ask("Helper")
    expect(loop === undefined ? -1 : cacheMarkers(loop)).toBe(1)
    expect(helper === undefined ? -1 : cacheMarkers(helper)).toBe(0)
  })
})
