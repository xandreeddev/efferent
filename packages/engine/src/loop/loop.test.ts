import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool, Toolkit } from "@effect/ai"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { Failure } from "../domain/Failure.js"
import type { LoopEvent } from "../domain/LoopEvent.js"
import { DEGENERATE_REPEAT_NUDGE, runLoop } from "./loop.js"

/** A scripted provider: call N returns `script(N)`'s encoded parts. */
const scriptedModel = (script: (call: number) => ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () =>
        Ref.getAndUpdate(calls, (n) => n + 1).pipe(
          Effect.map((n) => script(n) as never),
        ),
      streamText: () => Stream.die("not scripted") as never,
    })
  })

const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish",
  reason,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
})

const Echo = Tool.make("echo", {
  description: "echo a value back",
  parameters: { value: Schema.String },
  success: Schema.Struct({ echoed: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

const kit = Toolkit.make(Echo)
const handlers = Layer.mergeAll(
  kit.toLayer({ echo: ({ value }) => Effect.succeed({ echoed: value }) }),
)

const run = <A, E>(
  effect: Effect.Effect<A, E, LanguageModel.LanguageModel | Tool.Handler<"echo">>,
  script: (call: number) => ReadonlyArray<unknown>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(handlers),
      Effect.provideServiceEffect(LanguageModel.LanguageModel, scriptedModel(script)),
    ),
  )

const collect = () => {
  const events: Array<LoopEvent> = []
  const onEvent = (e: LoopEvent) => Effect.sync(() => void events.push(e))
  return { events, onEvent }
}

const user = (content: string) => ({ role: "user" as const, content })

describe("runLoop", () => {
  test("a plain text response completes in one turn with the event trail", async () => {
    const { events, onEvent } = collect()
    const result = await run(
      runLoop({ system: "sys", messages: [user("hi")], toolkit: kit, onEvent }),
      () => [{ type: "text", text: "hello there" }, finish("stop")],
    )
    expect(result.finalText).toBe("hello there")
    expect(result.outcome).toBe("ok")
    expect(result.reason).toBe("completed")
    expect(result.newTail).toHaveLength(1)
    expect(events.map((e) => e.type)).toEqual(["turn_start", "assistant_message", "agent_end"])
  })

  test("a tool-call turn resolves the handler and iterates to completion", async () => {
    const { events, onEvent } = collect()
    const result = await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit, onEvent }),
      (call) =>
        call === 0
          ? [
              { type: "tool-call", id: "c1", name: "echo", params: { value: "ping" } },
              finish("tool-calls"),
            ]
          : [{ type: "text", text: "done" }, finish("stop")],
    )
    expect(result.finalText).toBe("done")
    expect(result.outcome).toBe("ok")
    const toolEnd = events.find((e) => e.type === "tool_end")
    expect(toolEnd).toMatchObject({ toolName: "echo", ok: true })
    // The tool message persisted into the tail alongside the assistant ones.
    expect(result.newTail.filter((m) => m.role === "tool")).toHaveLength(1)
  })

  test("a wrong-shaped tool call is recovered — corrective feedback, then success", async () => {
    // In @effect/ai 0.35 a wrong-shaped param set fails at RESPONSE decode
    // (before Toolkit.handle), so recovery rides the loop's corrective path —
    // same outcome as a hallucinated name: the turn survives, the model fixes.
    const result = await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit }),
      (call) =>
        call === 0
          ? [
              { type: "tool-call", id: "c1", name: "echo", params: { wrong: true } },
              finish("tool-calls"),
            ]
          : [{ type: "text", text: "fixed" }, finish("stop")],
    )
    expect(result.finalText).toBe("fixed")
    expect(result.outcome).toBe("ok")
    const corrective = result.newTail.find(
      (m) => m.role === "user" && m.content.includes("could not be parsed"),
    )
    expect(corrective).toBeDefined()
  })

  test("a hallucinated tool NAME feeds a corrective and retries, bounded", async () => {
    const result = await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit }),
      (call) =>
        call === 0
          ? [
              { type: "tool-call", id: "c1", name: "not_a_tool", params: {} },
              finish("tool-calls"),
            ]
          : [{ type: "text", text: "recovered" }, finish("stop")],
    )
    expect(result.finalText).toBe("recovered")
    const corrective = result.newTail.find(
      (m) => m.role === "user" && m.content.includes("could not be parsed"),
    )
    expect(corrective).toBeDefined()
  })

  test("the degenerate-loop breaker nudges once, then force-stops as partial", async () => {
    const result = await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit }),
      () => [
        { type: "tool-call", id: "c1", name: "echo", params: { value: "same" } },
        finish("tool-calls"),
      ],
    )
    expect(result.outcome).toBe("partial")
    expect(result.reason).toBe("degenerate-loop")
    const nudges = result.newTail.filter(
      (m) => m.role === "user" && m.content === DEGENERATE_REPEAT_NUDGE,
    )
    expect(nudges).toHaveLength(1)
  })

  test("the step cap stops a run that still wants tools, as partial", async () => {
    const result = await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit, maxSteps: 2 }),
      (call) => [
        { type: "tool-call", id: `c${call}`, name: "echo", params: { value: `v${call}` } },
        finish("tool-calls"),
      ],
    )
    expect(result.outcome).toBe("partial")
    expect(result.reason).toBe("step-cap")
  })

  test("onTail receives every appended message incrementally, correctives included", async () => {
    const seen: Array<string> = []
    const onTail = (tail: ReadonlyArray<{ role: string }>) =>
      Effect.sync(() => {
        seen.push(...tail.map((m) => m.role))
        return [] as ReadonlyArray<number>
      })
    await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit, onTail }),
      (call) =>
        call === 0
          ? [
              { type: "tool-call", id: "c1", name: "echo", params: { value: "x" } },
              finish("tool-calls"),
            ]
          : [{ type: "text", text: "done" }, finish("stop")],
    )
    expect(seen).toEqual(["assistant", "tool", "assistant"])
  })
})
