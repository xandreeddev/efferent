import { expect, test } from "bun:test"
import { Effect, Redacted, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { flushTelemetry } from "./otlp-telemetry.adapter.js"
import { LangSmithTelemetryLive } from "./langsmith-telemetry.adapter.js"

interface WireSpan {
  readonly name: string
  readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: { readonly stringValue?: string; readonly intValue?: string; readonly doubleValue?: number } }>
}
interface Post { readonly resourceSpans: ReadonlyArray<{ readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<WireSpan> }> }> }
const attributes = (span: WireSpan) => Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.doubleValue]))

const collect = (program: (url: string) => Effect.Effect<unknown, unknown>) => Effect.scoped(Effect.gen(function* () {
  const posts: Post[] = []
  const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => { posts.push(await request.json()); return Response.json({}) },
  })), (server) => Effect.sync(() => server.stop(true)))
  yield* program(`http://127.0.0.1:${server.port}/traces`)
  return posts.flatMap((post) => post.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)))
}))
const options = (tracesUrl: string) => ({ apiKey: Redacted.make("fixture-key"), target: { _tag: "Project" as const, project: "fixture" }, serviceName: "inheritance-fixture", tracesUrl, protocol: "http/json" as const, exportInterval: "1 hour" as const })
const knownModel = LanguageModel.make({
  generateText: ({ span }) => Effect.sync(() => {
    span.attribute("gen_ai.operation.name", "chat")
    span.attribute("gen_ai.usage.input_tokens", 7)
    return [{ type: "text", text: "local response" }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 7 }, outputTokens: { total: 2 } } }]
  }),
  streamText: () => Stream.die("not scripted"),
})

test("an inherited noninference host kind preserves the actual native model's inference and usage", async () => {
  const spans = await Effect.runPromise(collect((url) => Effect.gen(function* () {
    const model = yield* knownModel
    yield* model.generateText({ prompt: "local prompt" }).pipe(
      Effect.annotateSpans({ "langsmith.span.kind": "tool" }),
      Effect.withSpan("host.authored_tool", { attributes: { "langsmith.span.kind": "tool" } }),
    )
    yield* flushTelemetry
  }).pipe(Effect.provide(LangSmithTelemetryLive(options(url))))))
  expect(attributes(spans.find((span) => span.name === "host.authored_tool")!)["langsmith.span.kind"]).toBe("tool")
  const native = spans.find((span) => span.name === "LanguageModel.generateText")!
  expect(attributes(native)["langsmith.span.kind"]).toBe("llm")
  expect(Number(attributes(native)["gen_ai.usage.input_tokens"])).toBe(7)
})

test("an explicitly authored neutral inference parent and native child are accounted once", async () => {
  const spans = await Effect.runPromise(collect((url) => Effect.gen(function* () {
    const model = yield* knownModel
    yield* model.generateText({ prompt: "local prompt" }).pipe(Effect.withSpan("host.neutral_inference", { attributes: { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 7 } }))
    yield* flushTelemetry
  }).pipe(Effect.provide(LangSmithTelemetryLive(options(url))))))
  const inference = spans.filter((span) => attributes(span)["langsmith.span.kind"] === "llm")
  expect(inference).toHaveLength(1)
  expect(inference.reduce((sum, span) => sum + Number(attributes(span)["gen_ai.usage.input_tokens"] ?? 0), 0)).toBe(7)
})
