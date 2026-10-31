import { expect, test } from "bun:test"
import { Cause, Context, Deferred, Effect, Fiber, Option, Ref, Schema, SchemaGetter, Stream } from "effect"
import type { Scope } from "effect"
import { Tool, Toolkit } from "effect/ai"
import {
  ActionPolicy, ConversationId, CurrentAgentRun, CurrentAgentStep, defineCapability, defineSkill, defineTool,
  Failure, harnessCodeOf, InvocationId, makeTurnEvents, makeTurnTasks, openLogSession, RunContext, RunId, RunOrdinal,
  SessionLogError, ToolCallId, ToolInterceptor, UserMessage, zeroUsage,
} from "@xandreed/core"
import { CurrentToolResultReceipt, makeToolResultReceipt } from "@xandreed/core/internal"
import type { Capability, LogEntry, MemoryPolicy, ToolInterceptor as Interceptor, TurnEvent } from "@xandreed/core"
import { makeRegistry } from "./registry.adapter.js"
import type { DiscoveryConfig } from "./registry.adapter.js"

const config: DiscoveryConfig = { grants: [], loadSkill: false, maxCallsPerRun: 20, maxSkillLoadsPerRun: 4, readConcurrency: 2, matcherTimeoutMs: 1000, catalogVersion: "test" }
const memoryPolicy: MemoryPolicy = {
  strategy: { id: "interception-test", version: "1" }, render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
  digestOnWrite: Option.none(), maintain: () => Effect.succeed({ actions: [], digest: [] }),
}
const address = { owner: "fixture", id: ConversationId.make("00000000-0000-4000-8000-000000000029") }
const userMessage = new UserMessage({ text: "exercise interception" })
const runId = RunId.make("interception-run")
const capability = (tools: Capability["tools"]): Capability => defineCapability({ id: "interception-fixture", version: "1", tools, skills: [defineSkill({ id: "interception-fixture", summary: "Exercise interception.", always: true, tools: tools.map((entry) => entry.tool.name) })] })
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.timeout("3 seconds")))
const fixture = (tools: Capability["tools"], options: {
  readonly interceptor?: Interceptor["Service"]
  readonly services?: Context.Context<never>
  readonly flush?: Effect.Effect<void, SessionLogError>
  readonly policy?: Partial<DiscoveryConfig>
} = {}) => Effect.gen(function* () {
  const rows = yield* Ref.make<ReadonlyArray<LogEntry>>([])
  const session = yield* openLogSession({ read: Ref.get(rows), snapshot: Ref.get(rows), append: (entries) => Ref.update(rows, (all) => [...all, ...entries]) }, memoryPolicy, { runId })
  yield* session.record([{ _tag: "TurnStarted", userMessage }], 0)
  const events = yield* makeTurnEvents({ maxDepth: 20 })
  const seen = yield* Ref.make<ReadonlyArray<TurnEvent>>([])
  yield* events.subscribe((event) => Option.some(event), (event) => Ref.update(seen, (all) => [...all, event]))
  const tasks = yield* makeTurnTasks(yield* Effect.scope)
  const context = RunContext.of({ conversation: address.id, session: address, runId, userMessage,
    admitted: { session: address, runId, turn: 1, key: runId, origin: "user", userMessage, command: {}, claimed: [], meta: {} },
    memory: session, events, tasks, activate: () => Effect.succeed([]), flush: options.flush ?? Effect.void, write: (op) => op, usage: Effect.succeed(zeroUsage),
  })
  const registry = yield* makeRegistry({ ...config, ...options.policy }, [capability(tools)])
  const opened = registry.open(session).pipe(Effect.provideService(RunContext, context), Effect.provide(options.services ?? Context.empty()))
  const openedTools = yield* options.interceptor === undefined ? opened : opened.pipe(Effect.provideService(ToolInterceptor, options.interceptor))
  yield* openedTools.select(userMessage)
  const api = yield* openedTools.toolkit.pipe(Effect.provide(openedTools.handlers))
  return { tools: openedTools, api, seen: Ref.get(seen), session, registry }
})
const invoke = (api: Toolkit.WithHandler<Record<string, Tool.Any>>, name: string, input: unknown, id = "same-id") =>
  api.handle(name, input, id).pipe(Effect.flatMap(Stream.runCollect), Effect.map((results) => results.at(-1)!)) as Effect.Effect<Tool.HandlerResult<Tool.Any>, unknown>

const Read = Tool.make("intercept_read", { parameters: Schema.Struct({ n: Schema.NumberFromString }), success: Schema.NumberFromString, failure: Failure, failureMode: "return" })
const CodecOffset = Context.Reference<number>("fixture/InterceptorCodecOffset", { defaultValue: () => 0 })

test("rewrite reauthorizes decoded params while callbacks see detached encoded input and actual outcome", () => run(Effect.gen(function* () {
  const authorized: unknown[] = []
  const before: unknown[] = []
  const after: unknown[] = []
  const handled: number[] = []
  const opened = yield* fixture([defineTool({ tool: Read, handler: ({ n }) => Effect.sync(() => { handled.push(n); return n }), view: { version: "1", render: (value, params) => `n=${params.n}; result=${value}`, compact: (value, params) => `old n=${params.n}; result=${value}` } })], {
    interceptor: { before: (input) => Effect.sync(() => { before.push(input); return { _tag: "Rewrite", input: { n: "002" } } }), after: (input) => Effect.sync(() => { after.push(input); return { _tag: "Replace", outcome: { _tag: "Success", encoded: "003" } } }) },
    services: Context.make(ActionPolicy, { authorize: (_tool, params) => Effect.sync(() => { authorized.push(params) }) }),
  })
  const result = yield* invoke(opened.api, Read.name, { n: "001" }).pipe(Effect.provideService(CurrentAgentRun, Option.some({ id: runId, turn: 1, ordinal: RunOrdinal.make(0) })), Effect.provideService(CurrentAgentStep, Option.some(2)))
  expect(authorized).toEqual([{ n: 1 }, { n: 2 }])
  expect(handled).toEqual([2])
  expect(before).toEqual([{ invocationId: `${runId}:call:0`, tool: Read.name, toolCallId: "same-id", run: Option.some({ id: runId, turn: 1, ordinal: 0 }), step: 2, input: { n: "001" } }])
  expect(after).toEqual([{ invocationId: `${runId}:call:0`, tool: Read.name, toolCallId: "same-id", run: Option.some({ id: runId, turn: 1, ordinal: 0 }), step: 2, input: { n: "002" }, outcome: { _tag: "Success", encoded: "2" } }])
  expect({ result: result.result, encoded: result.encodedResult, failed: result.isFailure }).toEqual({ result: 3, encoded: "3", failed: false })
  const events = yield* opened.seen
  expect(events.map((event) => event._tag).filter((tag) => tag.startsWith("tool."))).toEqual(["tool.intercepted", "tool.started", "tool.completed", "tool.intercepted"])
  expect(events.flatMap((event) => event._tag === "tool.completed" ? [event.result] : [])).toEqual([2])
  expect((yield* opened.tools.views.view(Read.name, "3", { n: "002" }, false)).text).toBe("n=2; result=3")
  expect(yield* opened.tools.views.compact(Read.name, "3", { n: "002" })).toEqual(Option.some("old n=2; result=3"))
})))

test("Deny decodes the authored failure schema before returning it and consumes no call budget", () => run(Effect.gen(function* () {
  const TypedFailure = Failure.pipe(Schema.decodeTo(Schema.Struct({ error: Schema.String, message: Schema.String, decoded: Schema.Boolean }), {
    decode: SchemaGetter.transform((value) => ({ ...value, decoded: true })),
    encode: SchemaGetter.transform(({ error, message }) => ({ error, message })),
  }))
  const Typed = Tool.make("typed_deny", { parameters: Tool.EmptyParams, success: Schema.String, failure: TypedFailure, failureMode: "return" })
  const handled: number[] = []
  const opened = yield* fixture([defineTool({ tool: Typed, handler: () => Effect.sync(() => { handled.push(1); return "actual" }) })], {
    policy: { maxCallsPerRun: 1 }, interceptor: { before: () => Effect.succeed({ _tag: "Deny", failure: { error: "Denied", message: "Use another operation." } }), after: () => Effect.die("Deny has no after") },
  })
  const first = yield* invoke(opened.api, Typed.name, {})
  const second = yield* invoke(opened.api, Typed.name, {}, "second")
  expect(first.result).toEqual({ error: "Denied", message: "Use another operation.", decoded: true })
  expect(second.result).toEqual(first.result)
  expect(handled).toEqual([])
  expect((yield* opened.seen).filter((event) => event._tag === "tool.started" || event._tag === "tool.completed")).toEqual([])
})))

test("a caller cannot change decoder input while its effectful codec is waiting", () => run(Effect.gen(function* () {
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const Params = Schema.Struct({ n: Schema.String })
  const Waiting = Tool.make("waiting_decode", { parameters: Schema.Unknown.pipe(Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.transformEffect((input) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(input))), encode: SchemaGetter.transform((input) => input),
  })), success: Schema.String, failure: Failure, failureMode: "return" })
  const evidence: unknown[] = []
  const opened = yield* fixture([defineTool({ tool: Waiting, handler: (input) => Schema.decodeUnknownEffect(Params)(input).pipe(Effect.map(({ n }) => n), Effect.orDie) })], { interceptor: { before: ({ input }) => Effect.sync(() => { evidence.push(input); return { _tag: "Allow" } }), after: () => Effect.succeed({ _tag: "Keep" }) } })
  const input = { n: "original" }
  const work = yield* invoke(opened.api, Waiting.name, input).pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  input.n = "mutated"
  yield* Deferred.succeed(release, undefined)
  expect((yield* Fiber.join(work)).result).toBe("original")
  expect(evidence).toEqual([{ n: "original" }])
})))

test("same-ID calls from a parameter codec cannot steal the outer lexical receipt", () => run(Effect.gen(function* () {
  const live = yield* Ref.make(Option.none<Toolkit.WithHandler<Record<string, Tool.Any>>>())
  const bare = yield* Ref.make(Option.none<Toolkit.WithHandler<Record<string, Tool.Any>>>())
  const handled: number[] = []
  const evidence: unknown[] = []
  const refused: boolean[] = []
  const Wire = Schema.Struct({ n: Schema.String })
  const Nested = Tool.make("nested_decode", { parameters: Wire.pipe(Schema.decodeTo(Schema.Struct({ n: Schema.Number }), {
    decode: SchemaGetter.transformEffect((input) => Effect.gen(function* () {
      if (input.n === "001") {
        yield* invoke(Option.getOrThrow(yield* Ref.get(live)), "nested_decode", { n: "003" }).pipe(Effect.orDie)
        const rejected = yield* invoke(Option.getOrThrow(yield* Ref.get(bare)), "nested_decode", { n: "009" }).pipe(Effect.exit)
        refused.push(rejected._tag === "Failure" && rejected.cause.reasons.some((reason) => Cause.isDieReason(reason) && Option.contains(harnessCodeOf(reason.defect), "tool.intercept")))
      }
      return { n: Number(input.n) }
    })), encode: SchemaGetter.transform(({ n }) => ({ n: String(n) })),
  })), success: Schema.NumberFromString, failure: Failure, failureMode: "return" })
  const opened = yield* fixture([defineTool({ tool: Nested, handler: ({ n }) => Effect.sync(() => { handled.push(n); return n }) })], {
    policy: { toolPolicy: { [Nested.name]: { concurrency: 1 } } },
    interceptor: { before: ({ input }) => Effect.gen(function* () {
      evidence.push(input)
      if (Option.exists(Schema.decodeUnknownOption(Wire)(input), ({ n }) => n === "001")) {
        yield* invoke(Option.getOrThrow(yield* Ref.get(live)), "nested_decode", { n: "004" }).pipe(Effect.orDie)
        return { _tag: "Rewrite", input: { n: "002" } }
      }
      return { _tag: "Allow" }
    }), after: () => Effect.succeed({ _tag: "Keep" }) },
  })
  yield* Ref.set(live, Option.some(opened.api))
  const dynamic: ReadonlyArray<Tool.Any> = [Nested]
  yield* Ref.set(bare, Option.some(yield* Toolkit.make(...dynamic).pipe(Effect.provide(opened.tools.handlers))))
  const target = { tool: Nested.name, toolCallId: "same-id", run: Option.some({ id: runId, turn: 1, ordinal: RunOrdinal.make(0) }), step: 0 }
  const receipt = yield* makeToolResultReceipt({ ...target, toolCallId: ToolCallId.make(target.toolCallId) })
  const result = yield* invoke(opened.api, Nested.name, { n: "001" }).pipe(
    Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Offer", offer: receipt.offer })),
    Effect.provideService(CurrentAgentRun, target.run), Effect.provideService(CurrentAgentStep, Option.some(0)),
  )
  const reserved = yield* receipt.recording.reserve({ ...target, toolCallId: ToolCallId.make(target.toolCallId) })
  expect(result.result).toBe(2)
  expect(handled).toEqual([3, 4, 2])
  expect(evidence).toEqual([{ n: "003" }, { n: "001" }, { n: "004" }])
  expect(refused).toEqual([true])
  expect((yield* opened.seen).flatMap((event) => event._tag === "tool.intercepted" ? [event.source] : [])).toEqual(["direct", "direct", "direct", "direct", "loop", "loop"])
  expect(reserved.metadata).toEqual(Option.some({ invocationId: InvocationId.make(`${runId}:call:2`), effectiveInput: { n: "002" } }))
  yield* reserved.close
})))

test("public bare Toolkit handlers cannot borrow an outer encoded-input capture", () => run(Effect.gen(function* () {
  const opened = yield* fixture([defineTool({ tool: Read, handler: ({ n }) => Effect.succeed(n) })], { interceptor: { before: () => Effect.succeed({ _tag: "Allow" }), after: () => Effect.succeed({ _tag: "Keep" }) } })
  const raw = yield* Toolkit.make(Read).pipe(Effect.provide(opened.tools.handlers))
  const exit = yield* raw.handle(Read.name, { n: "001" }, "same-id").pipe(Effect.flatMap(Stream.runCollect), Effect.exit)
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Failure") expect(exit.cause.reasons.some((reason) => reason._tag === "Die" && Option.contains(harnessCodeOf(reason.defect), "tool.intercept"))).toBe(true)
})))

test("an interception audit flush failure preserves identity and cannot enter the handler", () => run(Effect.gen(function* () {
  const original = new SessionLogError({ code: "store.io", message: "audit acknowledgment failed" })
  const handled: number[] = []
  const opened = yield* fixture([defineTool({ tool: Read, handler: ({ n }) => Effect.sync(() => { handled.push(n); return n }) })], { flush: Effect.fail(original), interceptor: { before: () => Effect.succeed({ _tag: "Allow" }), after: () => Effect.succeed({ _tag: "Keep" }) } })
  const exit = yield* invoke(opened.api, Read.name, { n: "001" }).pipe(Effect.exit)
  expect(exit._tag === "Failure" && exit.cause.reasons.some((reason) => reason._tag === "Die" && reason.defect === original)).toBe(true)
  expect(handled).toEqual([])
  expect((yield* opened.seen).filter((event) => event._tag === "tool.started")).toEqual([])
})))

test("reopened view, compact and digest decode both values and effective params in captured services", () => run(Effect.gen(function* () {
  const OffsetNumber = Schema.NumberFromString.pipe(Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transformEffect((value) => Effect.service(CodecOffset).pipe(Effect.map((offset) => value + offset))),
    encode: SchemaGetter.transformEffect((value) => Effect.service(CodecOffset).pipe(Effect.map((offset) => value - offset))),
  }))
  const Offset = Tool.make("offset_view", { parameters: Schema.Struct({ n: OffsetNumber }), success: OffsetNumber, failure: Failure, failureMode: "return" })
  const opened = yield* fixture([defineTool({ tool: Offset, handler: ({ n }) => Effect.succeed(n), view: {
    version: "1", render: (value, params) => `n=${params.n}; result=${value}`, compact: (value, params) => `old n=${params.n}; result=${value}`,
    digest: { _tag: "Summarize", version: "1", instructions: "Keep the fixture numbers.", preserve: (value) => [String(value)] },
  } })], { services: Context.make(CodecOffset, 10) })
  expect((yield* opened.tools.views.view(Offset.name, "3", { n: "002" }, false).pipe(Effect.provideService(CodecOffset, 99))).text).toBe("n=12; result=13")
  expect(yield* opened.tools.views.compact(Offset.name, "3", { n: "002" }).pipe(Effect.provideService(CodecOffset, 99))).toEqual(Option.some("old n=12; result=13"))
  expect(Option.map(yield* opened.tools.views.digest(Offset.name, "3", { n: "002" }, userMessage).pipe(Effect.provideService(CodecOffset, 99)), (task) => [task.source, task.preserve])).toEqual(Option.some(["n=12; result=13", ["13"]]))
})))

test("after sees the existing handler encoding while final Toolkit encoding stays authoritative", () => run(Effect.gen(function* () {
  const encodes = yield* Ref.make(0)
  const seen: unknown[] = []
  const Stateful = Tool.make("stateful_encoding", { parameters: Tool.EmptyParams,
    success: Schema.Number.pipe(Schema.decodeTo(Schema.Number, {
      decode: SchemaGetter.transform((value) => value),
      encode: SchemaGetter.transformEffect((value) => Ref.updateAndGet(encodes, (count) => count + 1).pipe(Effect.map((count) => value + count))),
    })), failure: Failure, failureMode: "return",
  })
  const opened = yield* fixture([defineTool({ tool: Stateful, handler: () => Effect.succeed(1) })], {
    interceptor: { before: () => Effect.succeed({ _tag: "Allow" }), after: ({ outcome }) => Effect.sync(() => { seen.push(outcome); return { _tag: "Keep" } }) },
  })
  const result = yield* invoke(opened.api, Stateful.name, {})
  expect(seen).toEqual([{ _tag: "Success", encoded: 2 }])
  expect(result.encodedResult).toBe(3)
  expect(yield* Ref.get(encodes)).toBe(2)
})))
