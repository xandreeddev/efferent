import { describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Option, Tracer } from "effect"
import { langSmithTracer } from "./langsmith-tracer.adapter.js"

const external = Tracer.externalSpan({ traceId: "1".repeat(32), spanId: "2".repeat(16) })
const options = (name: string, parent: Option.Option<Tracer.AnySpan> = Option.none()) => ({ name, parent, annotations: Context.empty(), links: [], startTime: 1n, kind: "internal" as const, root: false, sampled: true })
const ended = (span: Tracer.Span) => { span.end(10n, Exit.succeed(undefined)); return Object.fromEntries(span.attributes) }

describe("LangSmith tracer", () => {
  test("preserves original objects, prototype getters, context, ancestry, events, links and repeated end", () => {
    const created: Tracer.NativeSpan[] = []
    const underlying = Tracer.make({
      span: (input) => { const span = new Tracer.NativeSpan(input); created.push(span); return span },
      context: (primitive, fiber) => primitive["~effect/Effect/evaluate"](fiber),
    })
    const tracer = langSmithTracer(underlying)
    expect(tracer.context).toBe(underlying.context)
    const span = tracer.span(options("LanguageModel.generateText", Option.some(external)))
    expect(span).toBe(created[0]!)
    expect(Object.getPrototypeOf(span)).toBe(Tracer.NativeSpan.prototype)
    expect(span.traceId).toBe(external.traceId)
    expect(span.spanId).toHaveLength(16)
    span.event("checkpoint", 2n, { count: 1 })
    span.addLinks([{ span: external, attributes: { linked: true } }])
    const exit = Exit.fail("failed")
    span.end(3n, exit)
    span.end(4n, Exit.succeed(undefined))
    expect(span.status).toEqual({ _tag: "Ended", startTime: 1n, endTime: 3n, exit })
    expect(created[0]!.events).toEqual([["checkpoint", 2n, { count: 1 }]])
    expect(span.links).toEqual([{ span: external, attributes: { linked: true } }])
    expect(span.attributes.get("langsmith.span.kind")).toBe("llm")
  })

  test("all native operations own only their own usage and current aliases win", () => {
    const tracer = langSmithTracer(Tracer.nativeTracer)
    ;["LanguageModel.generateText", "LanguageModel.generateObject", "LanguageModel.streamText"].forEach((name) => {
      const span = tracer.span(options(name))
      span.attribute("gen_ai.provider.name", "fixture")
      span.attribute("gen_ai.usage.input_tokens", 0)
      span.attribute("gen_ai.usage.cache_creation.input_tokens", 7)
      span.attribute("gen_ai.usage.cache_write.input_tokens", 3)
      const attributes = ended(span)
      expect(attributes).toMatchObject({ "langsmith.span.kind": "llm", "gen_ai.system": "fixture", "gen_ai.usage.input_tokens": 0, "gen_ai.usage.cache_write.input_tokens": 3 })
      expect(attributes["gen_ai.usage.output_tokens"]).toBeUndefined()
    })
    const missing = ended(tracer.span(options("LanguageModel.generateText")))
    expect(Object.keys(missing).some((key) => key.startsWith("gen_ai.usage."))).toBe(false)
    const alias = tracer.span(options("LanguageModel.generateText"))
    alias.attribute("gen_ai.provider.name", "new")
    alias.attribute("gen_ai.system", "explicit")
    alias.attribute("gen_ai.usage.cache_creation.input_tokens", 7)
    expect(ended(alias)).toMatchObject({ "gen_ai.system": "explicit", "gen_ai.usage.cache_write.input_tokens": 7 })
  })

  test("wrappers and synthetic calls cannot be reclassified or billed through alternate backend attributes", () => {
    const tracer = langSmithTracer(Tracer.nativeTracer)
    ;["agent.turn", "engine.run", "engine.turn", "providers.generate", "models.utility", "loop.tool_call"].forEach((name) => {
      const span = tracer.span(options(name))
      Object.entries({ "gen_ai.usage.input_tokens": 50, "llm.token_count.prompt": 50, "llm.usage.total_tokens": 60, "llm.cost.total": 2, "gen_ai.cost.input": 1, "traceloop.span.kind": "llm", "openinference.span.kind": "LLM", "gen_ai.operation.name": "chat" }).forEach(([key, value]) => span.attribute(key, value))
      expect(ended(span)).toEqual({ "langsmith.span.kind": "chain" })
    })
    const synthetic = tracer.span(options("LanguageModel.generateText"))
    synthetic.attribute("efferent.inference.synthetic", true)
    synthetic.attribute("gen_ai.usage.input_tokens", 10)
    expect(ended(synthetic)).toEqual({ "efferent.inference.synthetic": true, "langsmith.span.kind": "chain" })
  })

  test("an explicit host inference span owns accounting over its nested native operation", () => {
    const tracer = langSmithTracer(Tracer.nativeTracer)
    const host = tracer.span(options("host.request"))
    host.attribute("langsmith.span.kind", "llm")
    host.attribute("gen_ai.usage.input_tokens", 5)
    const native = tracer.span(options("LanguageModel.generateText", Option.some(host)))
    native.attribute("gen_ai.operation.name", "chat")
    native.attribute("gen_ai.usage.input_tokens", 5)
    expect(ended(native)).toEqual({ "langsmith.span.kind": "chain" })
    expect(ended(host)).toEqual({ "langsmith.span.kind": "llm", "gen_ai.usage.input_tokens": 5 })
  })

  test("an inherited explicit kind cannot duplicate an explicit parent's native inference boundary", () => {
    const tracer = langSmithTracer(Tracer.nativeTracer)
    const host = tracer.span(options("host.request"))
    host.attribute("langsmith.span.kind", "llm")
    host.attribute("gen_ai.usage.input_tokens", 5)
    const native = tracer.span(options("LanguageModel.generateText", Option.some(host)))
    native.attribute("langsmith.span.kind", "llm")
    native.attribute("gen_ai.usage.input_tokens", 5)
    expect(ended(native)).toEqual({ "langsmith.span.kind": "chain" })
    expect(ended(host)).toEqual({ "langsmith.span.kind": "llm", "gen_ai.usage.input_tokens": 5 })
    const ignored = tracer.span(options("engine.turn"))
    ignored.attribute("langsmith.span.kind", "llm")
    const actual = tracer.span(options("LanguageModel.generateText", Option.some(ignored)))
    expect(ended(actual)["langsmith.span.kind"]).toBe("llm")
    expect(ended(ignored)["langsmith.span.kind"]).toBe("chain")
  })

  test("unknown operation values are not coerced into inference operations", () => {
    const tracer = langSmithTracer(Tracer.nativeTracer)
    const state = { coerced: 0 }
    const span = tracer.span(options("host.request"))
    span.attribute("gen_ai.operation.name", { toString: () => { state.coerced++; return "chat" } })
    expect(ended(span)).toEqual({ "langsmith.span.kind": "chain" })
    expect(state.coerced).toBe(0)
  })

  test("Effect.annotateSpans inheritance still leaves one explicit host inference owner", () => {
    const created: Tracer.NativeSpan[] = []
    const tracer = langSmithTracer(Tracer.make({ span: (input) => { const span = new Tracer.NativeSpan(input); created.push(span); return span } }))
    Effect.runSync(Effect.annotateCurrentSpan("gen_ai.usage.input_tokens", 5).pipe(
      Effect.withSpan("LanguageModel.generateText"),
      Effect.annotateSpans({ "langsmith.span.kind": "llm" }),
      Effect.withSpan("host.request", { attributes: { "langsmith.span.kind": "llm", "gen_ai.usage.input_tokens": 5 } }),
      Effect.withTracer(tracer),
    ))
    expect(created.filter((span) => span.attributes.get("langsmith.span.kind") === "llm").map((span) => span.name)).toEqual(["host.request"])
    expect(created.reduce((total, span) => total + Number(span.attributes.get("gen_ai.usage.input_tokens") ?? 0), 0)).toBe(5)
  })

  test("a non-inference host kind inherited by a native operation cannot erase its inference usage", () => {
    const created: Tracer.NativeSpan[] = []
    const tracer = langSmithTracer(Tracer.make({ span: (input) => { const span = new Tracer.NativeSpan(input); created.push(span); return span } }))
    Effect.runSync(Effect.annotateCurrentSpan("gen_ai.usage.input_tokens", 7).pipe(
      Effect.withSpan("LanguageModel.generateText"),
      Effect.annotateSpans({ "langsmith.span.kind": "tool" }),
      Effect.withSpan("host.authored_tool", { attributes: { "langsmith.span.kind": "tool" } }),
      Effect.withTracer(tracer),
    ))
    expect(created.find((span) => span.name === "LanguageModel.generateText")?.attributes.get("langsmith.span.kind")).toBe("llm")
    expect(created.find((span) => span.name === "LanguageModel.generateText")?.attributes.get("gen_ai.usage.input_tokens")).toBe(7)
    expect(created.find((span) => span.name === "host.authored_tool")?.attributes.get("langsmith.span.kind")).toBe("tool")
  })

  test("an authored neutral inference parent owns accounting without a LangSmith-specific annotation", () => {
    const created: Tracer.NativeSpan[] = []
    const tracer = langSmithTracer(Tracer.make({ span: (input) => { const span = new Tracer.NativeSpan(input); created.push(span); return span } }))
    Effect.runSync(Effect.annotateCurrentSpan("gen_ai.usage.input_tokens", 7).pipe(
      Effect.withSpan("LanguageModel.generateText"),
      Effect.withSpan("host.neutral_inference", { attributes: { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 7 } }),
      Effect.withTracer(tracer),
    ))
    expect(created.filter((span) => span.attributes.get("langsmith.span.kind") === "llm").map((span) => span.name)).toEqual(["host.neutral_inference"])
    expect(created.reduce((total, span) => total + Number(span.attributes.get("gen_ai.usage.input_tokens") ?? 0), 0)).toBe(7)
    const host = tracer.span(options("host.neutral_but_chain"))
    host.attribute("langsmith.span.kind", "chain")
    host.attribute("gen_ai.operation.name", "chat")
    const native = tracer.span(options("LanguageModel.generateText", Option.some(host)))
    expect(ended(native)["langsmith.span.kind"]).toBe("llm")
    expect(ended(host)["langsmith.span.kind"]).toBe("chain")
  })

  test("nested native wrappers leave the innermost actual inference owner and explicit supported types survive", () => {
    const tracer = langSmithTracer(Tracer.nativeTracer)
    const outer = tracer.span(options("LanguageModel.generateText"))
    const inner = tracer.span(options("LanguageModel.generateObject", Option.some(outer)))
    inner.attribute("gen_ai.usage.input_tokens", 4)
    expect(ended(inner)["langsmith.span.kind"]).toBe("llm")
    outer.attribute("gen_ai.usage.input_tokens", 4)
    expect(ended(outer)).toEqual({ "langsmith.span.kind": "chain" })
    ;["chain", "tool", "retriever", "embedding", "prompt", "parser"].forEach((kind) => {
      const span = tracer.span(options("host.authored"))
      span.attribute("langsmith.span.kind", kind)
      expect(ended(span)["langsmith.span.kind"]).toBe(kind)
    })
  })

  test("tool identity and already-consented engine content map without reading other payloads", () => {
    const tracer = langSmithTracer(Tracer.nativeTracer)
    const tool = tracer.span(options("tool.inspect"))
    tool.attribute("gen_ai.operation.name", "execute_tool")
    tool.attribute("gen_ai.tool.name", "inspect")
    tool.attribute("gen_ai.tool.call.id", "call")
    expect(ended(tool)).toEqual({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "inspect", "gen_ai.tool.call.id": "call", "langsmith.span.kind": "tool" })
    const chain = tracer.span(options("engine.turn"))
    chain.attribute("engine.step.input", "gated input")
    chain.attribute("engine.step.output", "gated output")
    expect(ended(chain)).toMatchObject({ "input.value": "gated input", "output.value": "gated output", "langsmith.span.kind": "chain" })
    expect(ended(tracer.span(options("engine.turn")))).toEqual({ "langsmith.span.kind": "chain" })
  })

  test("invalid parent IDs are omitted, valid sampling and links remain intact", () => {
    const tracer = langSmithTracer(Tracer.nativeTracer)
    const invalid = Tracer.externalSpan({ traceId: "noop", spanId: "noop" })
    const orphan = tracer.span(options("host", Option.some(invalid)))
    expect(orphan.parent).toEqual(Option.none())
    const unsampled = Tracer.externalSpan({ traceId: "1".repeat(32), spanId: "2".repeat(16), sampled: false })
    const descendant = tracer.span({ ...options("host", Option.some(unsampled)), sampled: false })
    expect(descendant.parent).toEqual(Option.some(unsampled))
    expect(descendant.sampled).toBe(false)
  })
})
