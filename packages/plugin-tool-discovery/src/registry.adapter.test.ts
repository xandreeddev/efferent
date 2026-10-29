import { describe, expect, test } from "bun:test"
import { Tool } from "effect/ai"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import type { Context } from "effect"
import {
  ConversationId,
  ConversationMemory,
  CurrentAgentStep,
  CurrentToolInvocation,
  defineCapability,
  defineSkill,
  defineTool,
  EntryId,
  Failure,
  HarnessError,
  harnessDefectsAsFailures,
  openLogSession,
  publishToolProgress,
  RunContext,
  ToolRegistry,
  TurnLive,
  TurnMemory,
  TurnToolbox,
  turnStartedDraft,
  UserMessage,
} from "@xandreed/core"
import type { MemoryPolicy, SessionLogEvent, ToolInvocation, TurnDraft, TurnEvent, TurnWriter } from "@xandreed/core"
import { makeRegistry } from "./registry.adapter.js"
import type { DiscoveryConfig } from "./registry.adapter.js"

const config: DiscoveryConfig = {
  grants: [], loadSkill: true, maxCallsPerRun: 8, maxSkillLoadsPerRun: 4, readConcurrency: 2, matcherTimeoutMs: 1_000, catalogVersion: "test",
}

const Report = Tool.make("report_progress", {
  description: "Report progress twice, then say which call this was.",
  parameters: Schema.Struct({}),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

/** A handler that reports output and a status, and returns the invocation it saw. */
const reporting = defineCapability({
  id: "reporting",
  version: "1",
  tools: [defineTool({
    tool: Report,
    handler: () => Effect.gen(function* () {
      const invocation = yield* Effect.service(CurrentToolInvocation)
      yield* publishToolProgress("stdout", "compiling")
      yield* publishToolProgress("status", "1 of 2")
      return Option.match(invocation, { onNone: () => "none", onSome: (call) => `${call.invocationId}|${call.tool}|${call.step}` })
    }),
  })],
  skills: [defineSkill({ id: "reporting", summary: "Report progress.", tools: [Report.name], always: true })],
})

const policy: MemoryPolicy = {
  strategy: { id: "test", version: "1" },
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0 } },
  digestOnWrite: Option.none(),
  maintain: () => Effect.succeed({ actions: [], digest: [] }),
}

/** A writer that stores the turn's events in memory: what the session would journal. */
const recordingWriter = Effect.gen(function* () {
  const session = ConversationId.make("00000000-0000-4000-8000-0000000000aa")
  const userMessage = new UserMessage({ text: "build it" })
  const draft = yield* turnStartedDraft(1, {
    runId: "run-1", key: "run-1", origin: "user", userMessage, command: {}, claimed: [], entry: EntryId.make("run-1:0"), at: 0,
  }).pipe(Effect.orDie)
  const started: SessionLogEvent = { session, seq: 1, turn: draft.turn, kind: draft.kind, at: 0, data: draft.data }
  const stored = yield* Ref.make<ReadonlyArray<SessionLogEvent>>([started])
  const append = (drafts: ReadonlyArray<TurnDraft>) => Ref.update(stored, (all) => [...all, ...drafts.map((next, index): SessionLogEvent => ({
    session, seq: all.length + index + 1, turn: Option.some(1), kind: next.kind, at: 0, data: next.data,
  }))])
  const writer: TurnWriter = {
    admitted: { session: { id: session, owner: "test" }, turn: 1, runId: "run-1", key: "run-1", origin: "user", userMessage, command: {}, claimed: [], meta: {} },
    started,
    history: () => Effect.succeed([]),
    snapshot: () => Ref.get(stored),
    append,
    write: (op) => op,
    transact: (decide) => decide([]).pipe(Effect.flatMap((decision) => append(decision.drafts).pipe(Effect.as({ result: decision.result, events: [] })))),
    flush: Effect.void,
    end: () => Effect.succeed({ pending: 0 }),
    closed: Effect.never,
  }
  return { writer, kinds: Ref.get(stored).pipe(Effect.map((all) => all.map((event) => event.kind))) }
})

/**
 * One turn over the real registry: open the tools (inside `outer`, as a
 * nested agent opened by another tool's handler would), call the tool at
 * step 2, and return how the call ended (a turn failure restored as at the
 * turn boundary), what the handler saw, what the bus carried and what was
 * stored. With `failOn`, an inline subscriber fails on that event.
 */
const callInTurn = (outer: Option.Option<ToolInvocation>, failOn: Option.Option<TurnEvent["_tag"]> = Option.none()) => Effect.scoped(Effect.gen(function* () {
  const recorded = yield* recordingWriter
  const registry = yield* makeRegistry(config, [reporting])
  const services = Layer.merge(
    Layer.succeed(ConversationMemory, ConversationMemory.of({ strategy: policy.strategy, open: ({ runId, log }) => openLogSession(log, policy, { runId }) })),
    Layer.succeed(ToolRegistry, ToolRegistry.of({ catalog: registry.catalog, open: registry.open })),
  )
  return yield* Effect.gen(function* () {
    const run = yield* RunContext
    const published = yield* Ref.make<ReadonlyArray<TurnEvent>>([])
    yield* run.events.subscribe(Option.some, (event) => Ref.update(published, (all) => [...all, event]))
    yield* Option.match(failOn, {
      onNone: () => Effect.void,
      onSome: (tag) => run.events.subscribe((event) => Option.liftPredicate(event, (candidate) => candidate._tag === tag),
        () => Effect.fail(new HarnessError({ code: "test.renderer", message: `the renderer broke on ${tag}` }))),
    })
    yield* (yield* TurnMemory).persistMessage
    // Outside a tool call progress goes nowhere.
    yield* publishToolProgress("status", "before any tool")
    const tools = yield* (yield* TurnToolbox).open.pipe(Effect.provideService(CurrentToolInvocation, outer))
    yield* tools.select(run.userMessage)
    // The open toolkit is typed over any tool, so its handler services are `any`: the registry's handlers need none.
    const handled: Effect.Effect<ReadonlyArray<{ readonly result: unknown }>, unknown> = Effect.gen(function* () {
      const kit = yield* tools.toolkit.pipe(Effect.provide(tools.handlers as Context.Context<Tool.HandlersFor<Record<string, Tool.Any>>>))
      return yield* Stream.runCollect(yield* kit.handle(Report.name, {}))
    }) as never
    const outcome = yield* harnessDefectsAsFailures(handled.pipe(Effect.provideService(CurrentAgentStep, Option.some(2)), Effect.provideService(CurrentToolInvocation, outer))).pipe(Effect.result)
    yield* run.flush
    const events = (yield* Ref.get(published)).filter((event) => event._tag.startsWith("tool."))
    return {
      saw: outcome._tag === "Success" ? outcome.success.at(-1)?.result : undefined,
      failure: outcome._tag === "Failure" && outcome.failure instanceof HarnessError ? `${outcome.failure.code}: ${outcome.failure.message}` : "none",
      events,
      stored: yield* recorded.kinds,
    }
  }).pipe(Effect.provide(TurnLive({ turn: recorded.writer })), Effect.provide(services))
}))

describe("the registry tells a handler which call it runs for", () => {
  test("a handler sees its invocation, its progress is published between tool.started and tool.completed, and progress is never journaled", async () => {
    const turn = await Effect.runPromise(callInTurn(Option.none()))
    expect(turn.saw).toBe("run-1:call:0|report_progress|2")
    expect(turn.events.map((event) => event._tag)).toEqual(["tool.started", "tool.progress", "tool.progress", "tool.completed"])
    const progress = turn.events.flatMap((event) => event._tag === "tool.progress" ? [event] : [])
    expect(progress).toEqual([
      { _tag: "tool.progress", step: 2, invocationId: "run-1:call:0", tool: "report_progress", channel: "stdout", text: "compiling" },
      { _tag: "tool.progress", step: 2, invocationId: "run-1:call:0", tool: "report_progress", channel: "status", text: "1 of 2" },
    ])
    expect(turn.stored).toContain("tool.started")
    expect(turn.stored).toContain("tool.completed")
    expect(turn.stored).not.toContain("tool.progress")
  })

  test("the invocation is provided innermost: a handler sees its own call even under another tool's", async () => {
    const outer = Option.some({ invocationId: "outer-run:call:7", tool: "delegate", step: 5 })
    const turn = await Effect.runPromise(callInTurn(outer))
    expect(turn.saw).toBe("run-1:call:0|report_progress|2")
    expect(turn.events.filter((event) => event._tag === "tool.progress").every((event) => event._tag === "tool.progress" && event.invocationId === "run-1:call:0")).toBe(true)
  })
})

describe("a subscriber failure during a tool call", () => {
  test("on tool.progress stops the handler and fails the turn after tool.completed, never reaching the model as the tool's result", async () => {
    const turn = await Effect.runPromise(callInTurn(Option.none(), Option.some("tool.progress")))
    expect(turn.failure).toBe("test.renderer: the renderer broke on tool.progress")
    expect(turn.saw).toBeUndefined()
    // The second report never ran; the call is still closed on the bus.
    expect(turn.events.map((event) => event._tag)).toEqual(["tool.started", "tool.progress", "tool.completed"])
    expect(turn.events.at(-1)).toMatchObject({ _tag: "tool.completed", ok: false })
  })

  test("on tool.started fails the turn before the handler runs", async () => {
    const turn = await Effect.runPromise(callInTurn(Option.none(), Option.some("tool.started")))
    expect(turn.failure).toBe("test.renderer: the renderer broke on tool.started")
    expect(turn.events.map((event) => event._tag)).toEqual(["tool.started"])
  })
})
