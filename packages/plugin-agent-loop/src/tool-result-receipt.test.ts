import { expect, test } from "bun:test"
import { Effect, Exit, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/ai"
import { EntryId, Failure, harnessError, InvocationId, RunId, RunOrdinal } from "@xandreed/core"
import { CurrentToolResultReceipt, makeToolResultReceipt } from "@xandreed/core/internal"
import { runLoop } from "./loop.js"

const Probe = Tool.make("receipt_probe", { description: "Exercise invocation ownership.", parameters: Tool.EmptyParams, success: Schema.String, failure: Failure, failureMode: "return" })
const toolkit = Toolkit.make(Probe)
const run = { id: RunId.make("receipt-loop"), turn: 1, ordinal: RunOrdinal.make(2) }
const noModel = LanguageModel.make({ generateText: () => Effect.die("the planned batch must not call a model"), streamText: () => Stream.die("the planned batch must not stream") })
type ReceiptGuard = Effect.Success<ReturnType<typeof makeToolResultReceipt>>["guard"]

test("planned calls offer ownership to their handler, guard lifecycle callbacks and record under a separate capability", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    const guard = yield* Ref.make(Option.none<ReceiptGuard>())
    const handlers = yield* toolkit.toHandlers({ receipt_probe: () => Effect.gen(function* () {
      const context = yield* CurrentToolResultReceipt
      if (Option.isNone(context) || context.value._tag !== "Offer") return yield* Effect.die("handler lacks its offer")
      yield* Ref.set(guard, Option.some(context.value.offer.guard))
      const owner = yield* context.value.offer.enter(context.value.offer.guard.target)
      if (Option.isNone(owner)) return yield* Effect.die("handler could not enter")
      yield* owner.value.claim(InvocationId.make("receipt-loop:call:0")).pipe(Effect.orDie)
      yield* owner.value.ready(Option.none()).pipe(Effect.orDie)
      return "done"
    }) })
    yield* runLoop({
      toolkit, system: "Receipt fixture.", messages: [{ role: "user", content: "Exercise the planned call." }], run, maxSteps: 1, streaming: false,
      initialStep: [{ name: Probe.name, params: {} }],
      onEvent: (event) => event.type === "tool_start" || event.type === "tool_end" ? Effect.gen(function* () {
        const context = yield* CurrentToolResultReceipt
        if (Option.isSome(context) && context.value._tag === "Guard") {
          const status = yield* context.value.guard.status
          const transferable = Object.hasOwn(context.value, "offer")
          yield* Ref.update(seen, (all) => [...all, `${event.type}:${status}:${transferable}`])
        } else yield* Ref.update(seen, (all) => [...all, `${event.type}:unguarded`])
      }) : Effect.void,
      onTail: (tail) => tail.some((message) => message.role === "tool") ? Effect.gen(function* () {
        const context = yield* CurrentToolResultReceipt
        if (Option.isNone(context) || context.value._tag !== "Record") return yield* Effect.die("result lacks recording authority")
        const reservation = yield* context.value.recording.reserve(context.value.recording.guard.target)
        yield* Ref.update(seen, (all) => [...all, "recording"])
        yield* reservation.recorded(EntryId.make("receipt-loop:result"))
        return [1]
      }) : Effect.succeed([0]),
    }).pipe(Effect.provide(handlers), Effect.provideServiceEffect(LanguageModel.LanguageModel, noModel))
    const captured = yield* Ref.get(guard)
    return { seen: yield* Ref.get(seen), final: Option.isSome(captured) ? yield* captured.value.status : "missing", ambient: yield* CurrentToolResultReceipt }
  }))
  expect(result.seen).toEqual(["tool_start:Fresh:false", "tool_end:Ready:false", "recording"])
  expect(result.final).toBe("Closed")
  expect(result.ambient).toEqual(Option.none())
})

test("a failed planned invocation closes its receipt without recording a result", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const guard = yield* Ref.make(Option.none<ReceiptGuard>())
    const original = harnessError("tool.intercept", "fixture failure")
    const handlers = yield* toolkit.toHandlers({ receipt_probe: () => Effect.gen(function* () {
      const context = yield* CurrentToolResultReceipt
      if (Option.isSome(context) && context.value._tag === "Offer") yield* Ref.set(guard, Option.some(context.value.offer.guard))
      return yield* Effect.die(original)
    }) })
    const recorded = yield* Ref.make(0)
    const exit = yield* Effect.exit(runLoop({ toolkit, system: "Receipt fixture.", messages: [], run, maxSteps: 1, streaming: false, initialStep: [{ name: Probe.name, params: {} }],
      onTail: (tail) => Ref.update(recorded, (count) => count + tail.filter((message) => message.role === "tool").length).pipe(Effect.as([])),
    }).pipe(Effect.provide(handlers), Effect.provideServiceEffect(LanguageModel.LanguageModel, noModel)))
    const captured = yield* Ref.get(guard)
    return { failed: Exit.isFailure(exit), final: Option.isSome(captured) ? yield* captured.value.status : "missing", recorded: yield* Ref.get(recorded) }
  }))
  expect(result).toEqual({ failed: true, final: "Closed", recorded: 0 })
})
