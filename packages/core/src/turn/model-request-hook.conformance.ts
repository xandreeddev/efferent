import { Cause, Context, Deferred, Effect, Exit, Fiber, Option, Ref } from "effect"
import { check, eventually, expect } from "../conformance.functions.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { ConversationId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { harnessCodeOf } from "../harness/harness-code.entity.functions.js"
import { isHarnessError } from "../harness/plugin.entity.functions.js"
import { CurrentAgentRun, CurrentAgentStep } from "../loop/stepContext.js"
import { CurrentTraceContent } from "../loop/traceContent.js"
import { ModelRequestHook } from "../ports/model-request-hook.port.js"
import { SessionLogError } from "../session/session-log.entity.js"
import { TurnClosed } from "../session/sessions.entity.js"
import { applyModelRequestHook } from "./model-request-hook.entity.functions.js"
import type { ModelRequestDraft, ModelRequestPatch } from "./model-request-hook.entity.js"

/** The hook application edge; the SDK's durable writer is verified separately. @public */
export interface ModelRequestHookSubject { readonly apply: typeof applyModelRequestHook }
const draft = (): ModelRequestDraft => ({ run: { id: RunId.make("hook-kit"), turn: 2, ordinal: RunOrdinal.make(0) }, step: 1,
  activeTools: ["search", "read"], system: "base system", context: Option.some("policy context"), toolChoice: Option.some("required") })
const codeIs = (value: unknown, code: string) => Option.contains(harnessCodeOf(value), code)

/** Invocation, control semantics, snapshotting and failures; never a persistence claim. @public */
export const modelRequestHookConformance = (subject: ModelRequestHookSubject = { apply: applyModelRequestHook }): ReadonlyArray<ConformanceCheck> => [
  check("absent and empty hooks preserve controls with distinct provenance", "identity", () => Effect.gen(function* () {
    const input = draft()
    const absent = yield* subject.apply(input).pipe(Effect.updateContext((context: Context.Context<never>) => Context.omit(ModelRequestHook)(context)))
    yield* expect("identity", absent.system === input.system && Option.contains(absent.context, "policy context") && Option.contains(absent.toolChoice, "required") && Option.isNone(absent.hook), "absent hook changed controls")
    const calls = yield* Ref.make(0)
    const empty = yield* subject.apply(input).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as({})) }))
    yield* expect("identity", (yield* Ref.get(calls)) === 1 && empty.system === input.system && Option.contains(empty.context, "policy context") && Option.contains(empty.toolChoice, "required") && Option.isSome(empty.hook) && Object.keys(empty.hook.value).length === 0, "empty hook was skipped or changed controls/provenance")
  })),
  check("patch controls replace, append a host note or clear choice exactly", "controls", () => Effect.gen(function* () {
    const result = yield* subject.apply(draft()).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.succeed({ system: "replacement", context: "hook context", toolChoice: null }) }))
    yield* expect("controls", result.system === "replacement" && Option.contains(result.context, "policy context\n\n[Host note: hook context]") && Option.isNone(result.toolChoice), "replacement, append or clear semantics differ")
    const cases: ReadonlyArray<{ readonly context: Option.Option<string>; readonly patch: ModelRequestPatch; readonly expected: Option.Option<string> }> = [
      { context: Option.none(), patch: {}, expected: Option.none() },
      { context: Option.some(""), patch: { context: "" }, expected: Option.some("") },
      { context: Option.some(""), patch: { context: "hook context" }, expected: Option.some("[Host note: hook context]") },
    ]
    yield* Effect.forEach(cases, ({ context, patch, expected }) => subject.apply({ ...draft(), context }).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.succeed(patch) }),
      Effect.flatMap((prepared) => expect("controls", Option.getOrElse(prepared.context, () => "<none>") === Option.getOrElse(expected, () => "<none>"), "empty context changed absence semantics"))), { concurrency: 1 })
    const specific = yield* subject.apply(draft()).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.succeed({ system: "", toolChoice: { tool: "search" } }) }))
    yield* expect("controls", specific.system === "" && Option.isSome(specific.toolChoice) && typeof specific.toolChoice.value !== "string" && specific.toolChoice.value.tool === "search", "empty system or specific tool was lost")
  })),
  check("unknown patch fields and inactive patch-selected tools fail request.hook", "validation", () => Effect.gen(function* () {
    const rootExtra = { system: "changed", model: "forbidden" }
    const nestedExtra = { toolChoice: { tool: "search", extra: true } }
    const inactive = { toolChoice: { tool: "inactive" } }
    yield* Effect.forEach([rootExtra, nestedExtra, inactive], (patch) => subject.apply(draft()).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.succeed(patch) }), Effect.result,
      Effect.flatMap((result) => expect("validation", result._tag === "Failure" && codeIs(result.failure, "request.hook"), "invalid patch was accepted or lost its code"))), { concurrency: 1 })
  })),
  check("draft and accepted patch are detached immutable snapshots", "snapshot", () => Effect.scoped(Effect.gen(function* () {
    const choice = { tool: "search" }
    const input = { ...draft(), activeTools: ["search"], toolChoice: Option.some(choice) }
    const patch = { system: "accepted", toolChoice: { tool: "search" } }
    const seen = yield* Ref.make(Option.none<ModelRequestDraft>())
    const release = yield* Deferred.make<void>()
    const work = yield* subject.apply(input).pipe(Effect.provideService(ModelRequestHook, { prepare: (captured) => Ref.set(seen, Option.some(captured)).pipe(Effect.andThen(Deferred.await(release)), Effect.as(patch)) }), Effect.forkChild)
    const captured = yield* eventually(Ref.get(seen), Option.isSome)
    input.system = "mutated"; input.activeTools.push("mutated"); choice.tool = "mutated"
    yield* Deferred.succeed(release, undefined)
    const result = yield* Fiber.join(work)
    patch.system = "mutated"; patch.toolChoice.tool = "mutated"
    yield* expect("snapshot", Option.isSome(captured) && captured.value.system === "base system" && captured.value.activeTools.length === 1 && Option.isSome(captured.value.toolChoice) && typeof captured.value.toolChoice.value !== "string" && captured.value.toolChoice.value.tool === "search" && Object.isFrozen(captured.value) && Object.isFrozen(captured.value.activeTools), "hook saw aliased or mutable draft")
    yield* expect("snapshot", result.system === "accepted" && Option.isSome(result.hook) && result.hook.value.system === "accepted" && result.hook.value.toolChoice !== null && typeof result.hook.value.toolChoice === "object" && result.hook.value.toolChoice.tool === "search" && Object.isFrozen(result) && Object.isFrozen(result.hook.value), "accepted patch remained aliased or mutable")
  }))),
  check("application preserves the caller's actual reference context", "context", () => Effect.gen(function* () {
    const run = { id: RunId.make("caller-run"), turn: 4, ordinal: RunOrdinal.make(9) }
    const seen = yield* Ref.make(false)
    yield* subject.apply(draft()).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.gen(function* () {
      const actualRun = yield* CurrentAgentRun, step = yield* CurrentAgentStep, trace = yield* CurrentTraceContent
      yield* Ref.set(seen, Option.isSome(actualRun) && actualRun.value.id === run.id && actualRun.value.ordinal === 9 && Option.contains(step, 7) && trace)
      return {}
    }) }), Effect.provideService(CurrentAgentRun, Option.some(run)), Effect.provideService(CurrentAgentStep, Option.some(7)), Effect.provideService(CurrentTraceContent, true))
    yield* expect("context", yield* Ref.get(seen), "application replaced or captured the caller context")
  })),
  check("typed turn failures retain identity and foreign defects retain cause", "failures", () => Effect.gen(function* () {
    const errors = [new SessionLogError({ code: "store.io", message: "hook storage failed" }), new TurnClosed({ session: ConversationId.make("00000000-0000-4000-8000-000000000028"), turn: 2, reason: "ended" })]
    yield* Effect.forEach(errors, (original) => Effect.forEach([Effect.fail(original), Effect.die(original)], (failure) => subject.apply(draft()).pipe(Effect.provideService(ModelRequestHook, { prepare: () => failure }), Effect.result,
      Effect.flatMap((result) => expect("failures", result._tag === "Failure" && result.failure === original, "original TurnError was relabelled"))), { concurrency: 1 }), { concurrency: 1 })
    const original = new Error("hook fixture defect")
    const defect = yield* subject.apply(draft()).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.die(original) }), Effect.result)
    yield* expect("failures", defect._tag === "Failure" && isHarnessError(defect.failure) && codeIs(defect.failure, "request.hook") && defect.failure.cause === original, "foreign defect was swallowed or lost its cause")
  })),
  check("a held hook remains interruptible without reclassification", "interruptible", () => Effect.scoped(Effect.gen(function* () {
    const calls = yield* Ref.make(0), release = yield* Deferred.make<void>()
    const work = yield* subject.apply(draft()).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(Deferred.await(release)), Effect.as({})) }), Effect.uninterruptible, Effect.forkChild)
    const entered = yield* eventually(Ref.get(calls), (calls) => calls > 0)
    const stopping = yield* Fiber.interrupt(work).pipe(Effect.forkChild)
    const stopped = yield* eventually(Effect.sync(() => stopping.pollUnsafe() !== undefined), Boolean)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(stopping)
    const exit = yield* Fiber.await(work)
    yield* expect("interruptible", entered === 1 && stopped && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), "hook was skipped, masked or interruption was relabelled")
  }))),
]
