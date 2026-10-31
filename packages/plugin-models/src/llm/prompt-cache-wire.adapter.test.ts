import { describe, expect, test } from "bun:test"
import { Context, Effect, Option, Schema, Stream } from "effect"
import { Prompt } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { ENGINE_KEY, parseModelSelection } from "@xandreed/core"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import { CurrentModelSettings } from "../ports/model-settings.port.js"
import type { PromptCacheControl } from "./prompt-cache.entity.js"
import type { ModelSettings } from "./model-settings.entity.js"
import { buildProvider } from "./providers.js"

const fixture = () => {
  const requests: Array<Record<string, unknown>> = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const body = await request.json() as Record<string, unknown>
    requests.push(body)
    const message = { id: "msg_cache", type: "message", role: "assistant", model: body["model"], content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } }
    return body["stream"] === true
      ? new Response([
        { type: "message_start", message },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"ok":true}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
      : Response.json({ ...message, content: [{ type: "text", text: '{"ok":true}' }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } })
  } })
  return { requests, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const ask = (server: ReturnType<typeof fixture>, options: {
  readonly prompt: Prompt.RawInput
  readonly settings?: ModelSettings
  readonly capability?: boolean
  readonly ambient?: Schema.JsonObject
  readonly method?: "text" | "object" | "stream"
}) => Effect.runPromise(Effect.result(Effect.scoped(Effect.gen(function* () {
  const selection = yield* Effect.fromOption(parseModelSelection("gateway:claude-opus-4-7"))
  const built = yield* buildProvider(selection, undefined, undefined)
  const run = options.method === "stream"
    ? Stream.runDrain(built.svc.streamText({ prompt: options.prompt }))
    : options.method === "object"
      ? built.svc.generateObject({ prompt: options.prompt, schema: Schema.Struct({ ok: Schema.Boolean }) }).pipe(Effect.asVoid)
      : built.svc.generateText({ prompt: options.prompt }).pipe(Effect.asVoid)
  yield* run.pipe(Effect.updateContext((context: Context.Context<never>) => Context.merge(context,
    Context.makeUnsafe(new Map([["@effect/ai-anthropic/AnthropicLanguageModel/Config", options.ambient ?? {}]])),
  )))
}))).pipe(
  Effect.provideService(CurrentModelEndpoints, { gateway: { api: "anthropic-messages", url: server.url, apiKey: "cache-placeholder", ...(options.capability === undefined ? {} : { cacheControl: options.capability }) } }),
  Effect.provideService(CurrentModelSettings, options.settings === undefined ? {} : { "gateway:claude-opus-4-7": options.settings }),
  Effect.provide(FetchHttpClient.layer),
))

// Walk only actual cache-bearing protocol blocks, never tool input/schema data.
const markers = (body: Record<string, unknown>): ReadonlyArray<unknown> => {
  const blocks = (values: unknown): ReadonlyArray<unknown> => Array.isArray(values) ? values.flatMap((block: Record<string, unknown>) => [
    ...(block["type"] === "tool_result" ? blocks(block["content"]) : []),
    ...(block["cache_control"] == null ? [] : [block["cache_control"]]),
  ]) : []
  return [
    ...blocks(body["tools"]), ...blocks(body["system"]),
    ...(body["messages"] as Array<{ content: unknown }>).flatMap((message) => blocks(message.content)),
  ]
}
const ephemeral = { type: "ephemeral" } as const
const hour = { type: "ephemeral", ttl: "1h" } as const
const marked = (text: string, control: PromptCacheControl = hour) => ({ role: "user" as const, content: [{ type: "text" as const, text, options: { anthropic: { cacheControl: control } } }] })

describe("cache planning over the prepared Messages payload", () => {
  test("counts all caller markers, adds no fifth marker and preserves caller objects", async () => {
    const server = fixture()
    const prompt = Prompt.make([{ role: "system", content: "rules" }, ...[1, 2, 3, 4].map((n) => marked(`caller ${n}`)), { role: "user", content: "later unmarked text" }])
    const before = JSON.stringify(prompt)
    const result = await ask(server, { prompt }).finally(server.stop)
    expect(result._tag).toBe("Success")
    expect(markers(server.requests[0]!)).toEqual(Array(4).fill(hour))
    expect(JSON.stringify(prompt)).toBe(before)
  })

  test("rejects a fifth caller marker and short-before-long TTL order before HTTP", async () => {
    const server = fixture()
    const tooMany = await ask(server, { prompt: Prompt.make([1, 2, 3, 4, 5].map((n) => marked(`caller ${n}`))) })
    const order = await ask(server, { prompt: Prompt.make([marked("short", ephemeral), marked("long", hour)]), settings: { promptCache: { _tag: "Off" } } }).finally(server.stop)
    expect([tooMany._tag, order._tag]).toEqual(["Failure", "Failure"])
    expect(server.requests).toHaveLength(0)
  })

  test("default Auto selects stable history and strips the neutral volatile-tail marker", async () => {
    const server = fixture()
    const result = await ask(server, { prompt: Prompt.make([
      { role: "system", content: "stable rules" }, { role: "user", content: "stable user" }, { role: "assistant", content: "stable assistant" },
      { role: "user", content: "volatile current step", options: { [ENGINE_KEY]: { requestVolatile: true }, another: { keep: "opaque" } } },
    ]) }).finally(server.stop)
    expect(result._tag).toBe("Success")
    expect(markers(server.requests[0]!)).toEqual(Array(3).fill(ephemeral))
    const messages = server.requests[0]!["messages"] as Array<{ content: Array<{ text?: string; cache_control?: unknown }> }>
    expect(messages.flatMap((message) => message.content).find((block) => block.text === "volatile current step")?.cache_control == null).toBe(true)
    expect(JSON.stringify(server.requests)).not.toContain("requestVolatile")
  })

  test("Off leaves caller controls alone and TopLevel uses one slot without automatic explicit markers", async () => {
    const server = fixture()
    await ask(server, { prompt: Prompt.make([marked("caller", hour), { role: "user", content: "unmarked" }]), settings: { promptCache: { _tag: "Off" } } })
    await ask(server, { prompt: "top-level", settings: { promptCache: { _tag: "TopLevel", ttl: "1h" } } }).finally(server.stop)
    expect(markers(server.requests[0]!)).toEqual([hour])
    expect(markers(server.requests[1]!)).toEqual([])
    expect(server.requests[1]!["cache_control"]).toEqual(hour)
  })

  test("gateway capability removes SDK nulls, preserves business data keys and refuses caller controls", async () => {
    const server = fixture()
    const text = 'Business JSON: {"cache_control":null,"requestVolatile":true}'
    const allowed = await ask(server, { prompt: text, capability: false })
    const refused = await ask(server, { prompt: Prompt.make([marked("caller")]), capability: false }).finally(server.stop)
    expect([allowed._tag, refused._tag]).toEqual(["Success", "Failure"])
    expect(server.requests).toHaveLength(1)
    const body = server.requests[0]!
    expect(body).not.toHaveProperty("cache_control")
    expect(markers(body)).toEqual([])
    const content = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content
    expect(content[0]).toMatchObject({ type: "text", text })
    expect(content[0]).not.toHaveProperty("cache_control")
  })

  test.each(["text", "object", "stream"] as const)("%s requests validate ambient top-level controls against actual last-block controls", async (method) => {
    const server = fixture()
    const result = await ask(server, { prompt: Prompt.make([marked("explicit final", hour)]), method,
      settings: { promptCache: { _tag: "Off" } }, ambient: { cache_control: ephemeral },
    }).finally(server.stop)
    expect(result._tag).toBe("Failure")
    expect(server.requests).toHaveLength(0)
  })

  test("rejects controls whose inherited fields or serializer would change the validated wire value", async () => {
    const server = fixture()
    const inherited: PromptCacheControl = Object.create({ type: "ephemeral", ttl: "1h" })
    const serialized: PromptCacheControl = Object.assign(Object.create({ toJSON: () => hour }), ephemeral)
    // Existing Prompt values preserve opaque option references without a JSON decode.
    const raw = (control: PromptCacheControl) => Prompt.fromMessages([Prompt.makeMessage("user", {
      content: [Prompt.makePart("text", { text: "caller control", options: { anthropic: { cacheControl: control } } })],
    })])
    const first = await ask(server, { prompt: raw(inherited) })
    const second = await ask(server, { prompt: raw(serialized) }).finally(server.stop)
    expect([first._tag, second._tag]).toEqual(["Failure", "Failure"])
    expect(server.requests).toHaveLength(0)
  })

  test("one SDK model keeps candidate identities isolated across overlapping settled, object and streamed calls", async () => {
    const server = fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection("gateway:claude-opus-4-7"))
      const { svc } = yield* buildProvider(selection, undefined, undefined)
      yield* Effect.forEach(Array.from({ length: 18 }, (_, index) => index), (index) => {
        const prompt = Prompt.make([
          { role: "system", content: "stable rules" },
          ...[1, 2, 3, 4].map((n) => marked(`call ${index}, caller ${n}`)),
          { role: "user", content: "stable unmarked candidate" },
          { role: "user", content: "volatile tail", options: { [ENGINE_KEY]: { requestVolatile: true } } },
        ])
        return index % 3 === 0 ? svc.generateText({ prompt }).pipe(Effect.asVoid)
          : index % 3 === 1 ? svc.generateObject({ prompt, schema: Schema.Struct({ ok: Schema.Boolean }) }).pipe(Effect.asVoid)
            : Stream.runDrain(svc.streamText({ prompt }))
      }, { concurrency: 8, discard: true })
    })).pipe(
      Effect.provideService(CurrentModelEndpoints, { gateway: { api: "anthropic-messages", url: server.url } }),
      Effect.provide(FetchHttpClient.layer),
    )).finally(server.stop)
    expect(server.requests).toHaveLength(18)
    expect(server.requests.map(markers)).toEqual(Array.from({ length: 18 }, () => Array(4).fill(hour)))
    expect(JSON.stringify(server.requests)).not.toContain("requestVolatile")
  })
})
