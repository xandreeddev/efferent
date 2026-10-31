/** The public recorder kit over packed TurnLive and a real in-memory writer. */
import assert from "node:assert/strict"
import { Context, Effect, Exit, Layer, Option, Ref, Schema, Scope } from "effect"
import {
  Capabilities, CurrentModelCallRecorder, frameworkDraft, ModelCallData, RunId, RunOrdinal,
  SessionLogMemoryLive, Sessions, StepUsageData, storedJson, turnModelCallsOf,
  TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import { modelCallRecorderConformance } from "@xandreed/core/conformance"
import { MemoryWindowLive } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { ToolDiscoveryLive } from "@xandreed/plugin-tool-discovery"
import { TurnLive } from "@xandreed/sdk"

const subject = {
  open: (seed) => Effect.gen(function* () {
    const services = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "process" } }).pipe(
      Layer.provideMerge(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
    ))
    const sessions = Context.get(services, Sessions)
    const view = yield* sessions.create({ owner: "recorder-kit" })
    const address = { id: view.header.id, owner: "recorder-kit" }
    const writer = yield* sessions.begin(address, {
      _tag: "User", userMessage: new UserMessage({ text: "Inspect recorder durability." }),
      runId: RunId.make("recorder-kit"), key: "recorder-kit", command: {},
    })
    yield* Effect.forEach(seed.calls, (call) => Schema.encodeEffect(ModelCallData)(call).pipe(
      Effect.flatMap(storedJson), Effect.flatMap((data) => writer.append([frameworkDraft("model.called", data)])),
    ), { concurrency: 1, discard: true })
    yield* Effect.forEach(seed.legacy, (usage, step) => Schema.encodeEffect(StepUsageData)({
      step, run: RunOrdinal.make(0), model: usage.model, usage: usage.usage, finishReason: "stop",
    }).pipe(Effect.flatMap(storedJson), Effect.flatMap((data) => writer.append([frameworkDraft("step.usage", data)]))), { concurrency: 1, discard: true })
    yield* writer.flush
    const failure = yield* Ref.make(Option.none())
    // The real commit succeeds, then its acknowledgment is lost. A second
    // record of that key must retain the same error without another append.
    const controlled = { ...writer, flush: writer.flush.pipe(Effect.andThen(
      Ref.getAndSet(failure, Option.none()).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Effect.fail }))),
    )) }
    const owner = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
    const context = yield* Layer.buildWithScope(TurnLive({ turn: controlled }).pipe(
      Layer.provide(Layer.merge(MemoryWindowLive(), ToolDiscoveryLive().pipe(Layer.provide(Layer.succeed(Capabilities, []))))),
    ), owner)
    return {
      recorder: Context.get(context, CurrentModelCallRecorder),
      stored: writer.snapshot(["model.called"]).pipe(Effect.flatMap((events) => turnModelCallsOf(events, writer.admitted.turn))),
      failNext: (error) => Ref.set(failure, Option.some(error)),
      close: Scope.close(owner, Exit.void),
    }
  }),
}
const checks = modelCallRecorderConformance(subject)
assert.equal(checks.length, 6)
await Effect.runPromise(Effect.forEach(checks, (check) => check.run, { concurrency: 1, discard: true }).pipe(Effect.timeout("20 seconds")))
console.log(`model-call-recorder ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", checks: checks.length, recorderVerified: true })}`)
