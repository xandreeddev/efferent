import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Result, Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { ToolChoice } from "../domain/tool-choice.entity.js"
import { harnessError } from "../harness/harness-code.entity.functions.js"
import { isHarnessError } from "../harness/plugin.entity.functions.js"
import { ModelRequestHook } from "../ports/model-request-hook.port.js"
import { SessionLogError } from "../session/session-log.entity.js"
import { TurnClosed } from "../session/sessions.entity.js"
import type { TurnError } from "../session/sessions.entity.js"
import { applyModelRequestHook } from "./model-request-hook.entity.functions.js"
import { ModelRequestDraft, ModelRequestPatch, ModelRequestPreparation } from "./model-request-hook.entity.js"

const draft = (): ModelRequestDraft => ({ run: { id: RunId.make("request-hook"), turn: 1, ordinal: RunOrdinal.make(0) }, step: 0,
  activeTools: ["read"], system: "base", context: Option.some("policy"), toolChoice: Option.some("required") })
// A deliberately untyped host return is the schema edge under test.
const apply = (patch: unknown, input = draft()) => applyModelRequestHook(input).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.succeed(patch as ModelRequestPatch) }))
const errorOf = async (effect: Effect.Effect<unknown, TurnError>) => {
  const result = await Effect.runPromise(Effect.result(effect))
  expect(result._tag).toBe("Failure")
  return Result.getOrThrowWith(Result.flip(result), () => new Error("expected hook failure"))
}

test("the complete hook context framing and normalized controls are exact", async () => {
  expect(await Effect.runPromise(apply({ system: "replacement", context: "keep identifiers exact", toolChoice: null }))).toEqual({
    system: "replacement", context: Option.some("policy\n\n[Host note: keep identifiers exact]"), toolChoice: Option.none(),
    hook: Option.some({ system: "replacement", context: "keep identifiers exact", toolChoice: null }),
  })
  expect(await Effect.runPromise(apply({ context: "next" }, { ...draft(), context: Option.some("") }))).toEqual({
    system: "base", context: Option.some("[Host note: next]"), toolChoice: Option.some("required"), hook: Option.some({ context: "next" }),
  })
})

test("invalid hook edges use one exact error text and retain the original cause", async () => {
  const cause = new Error("private fixture detail")
  const failure = await errorOf(applyModelRequestHook(draft()).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.die(cause) })))
  expect(isHarnessError(failure) && { code: failure.code, message: failure.message, cause: failure.cause }).toEqual({
    code: "request.hook", message: "The model request hook could not be applied.", cause,
  })
})

test.each([
  { system: undefined }, { context: undefined }, { toolChoice: undefined }, { system: 1 }, { context: null },
  { model: "forbidden" }, { context: "valid", extra: true }, { toolChoice: "auto" }, { toolChoice: "none" },
  { toolChoice: { tool: "read", extra: true } }, { toolChoice: { tool: undefined } }, { toolChoice: { tool: "inactive" } },
  null, "patch", [],
])("invalid returned patch %# is refused", async (patch) => {
  expect(isHarnessError(await errorOf(apply(patch)))).toBe(true)
})

test("strict patch edge and existing choice vocabulary stay closed", () => {
  expect(Option.isNone(Schema.decodeUnknownOption(ModelRequestPatch, { onExcessProperty: "error" })({ system: "x", extra: true }))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(ModelRequestPatch, { onExcessProperty: "error" })({ toolChoice: { tool: "read", extra: true } }))).toBe(true)
  expect(Option.isSome(Schema.decodeUnknownOption(ToolChoice)("required"))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(ToolChoice)("auto"))).toBe(true)
})

test("invalid draft data fails before the host hook is invoked", async () => {
  const calls: number[] = []
  await Effect.runPromise(Effect.forEach([{ ...draft(), step: -1 }, { ...draft(), run: { ...draft().run, ordinal: -1 } }, { ...draft(), extra: true }], (input) =>
    applyModelRequestHook(input as ModelRequestDraft).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.sync(() => { calls.push(1); return {} }) }), Effect.result,
      Effect.tap((result) => Effect.sync(() => { expect(result._tag === "Failure" && isHarnessError(result.failure) && result.failure.code).toBe("request.hook") }))), { concurrency: 1 }))
  expect(calls).toEqual([])
})

test("getters are captured once and inherited serialization cannot change accepted controls", async () => {
  const reads: number[] = []
  const varying = { get system() { reads.push(1); return reads.length === 1 ? "first" : "later" } }
  const prepared = await Effect.runPromise(apply(varying))
  expect(prepared.system).toBe("first")
  expect(prepared.hook).toEqual(Option.some({ system: "first" }))
  expect(reads).toHaveLength(1)
  const inherited = Object.create({ system: "inherited", toJSON: () => ({ system: "serialized differently" }) })
  const result = await Effect.runPromise(apply(inherited))
  expect(result.system).toBe("inherited")
  expect(await Effect.runPromise(Schema.encodeEffect(ModelRequestPreparation)(result))).toEqual({
    system: "inherited", context: "policy", toolChoice: "required", hook: { system: "inherited" },
  })
  const own = { system: "own" }
  Object.defineProperty(own, "toJSON", { value: () => ({ system: "changed" }) })
  expect((await Effect.runPromise(apply(own))).hook).toEqual(Option.some({ system: "own" }))
  expect(isHarnessError(await errorOf(apply({ system: "own", toJSON: () => ({ system: "changed" }) })))).toBe(true)
})

test("execution-time service selection and legacy inactive base choice are preserved", async () => {
  const pending = applyModelRequestHook({ ...draft(), toolChoice: Option.some({ tool: "old inactive policy choice" }) })
  expect((await Effect.runPromise(pending)).toolChoice).toEqual(Option.some({ tool: "old inactive policy choice" }))
  expect((await Effect.runPromise(pending.pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.succeed({}) })))).toolChoice).toEqual(Option.some({ tool: "old inactive policy choice" }))
  expect((await Effect.runPromise(pending.pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.succeed({ system: "call one" }) })))).system).toBe("call one")
  expect((await Effect.runPromise(pending.pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.succeed({ system: "call two" }) })))).system).toBe("call two")
})

test("synchronous callback throws and unexpected typed host errors stay at the hook boundary", async () => {
  const unknown = new Error("host threw")
  const thrown = await errorOf(applyModelRequestHook(draft()).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Result.getOrThrow(Result.fail(unknown)) })))
  expect(isHarnessError(thrown) && thrown.cause).toBe(unknown)
  const foreign = await errorOf(applyModelRequestHook(draft()).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.fail(unknown as TurnError) })))
  expect(isHarnessError(foreign) && foreign.cause).toBe(unknown)
  const errors = [new SessionLogError({ code: "store.io", message: "original" }), new TurnClosed({ session: ConversationId.make("00000000-0000-4000-8000-000000000028"), turn: 1, reason: "ended" }), harnessError("turn.defect", "original", unknown)]
  await Effect.runPromise(Effect.forEach(errors, (original) => applyModelRequestHook(draft()).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Result.getOrThrow(Result.fail(original)) }), Effect.result,
    Effect.tap((result) => Effect.sync(() => { expect(result._tag === "Failure" && result.failure).toBe(original) }))), { concurrency: 1 }))
})


test("a host callback stays interruptible inside caller bookkeeping masks", async () => {
  const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const work = yield* applyModelRequestHook(draft()).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as({})) }), Effect.uninterruptible, Effect.forkChild)
    yield* Deferred.await(entered)
    const stopped = yield* Fiber.interrupt(work).pipe(Effect.timeoutOption("100 millis"))
    yield* Deferred.succeed(release, undefined)
    expect(Option.isSome(stopped)).toBe(true)
    return yield* Fiber.await(work)
  })))
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
})
