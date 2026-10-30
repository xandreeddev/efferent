import { describe, expect, test } from "bun:test"
import { Tool } from "effect/ai"
import { Cause, Effect, Layer, Logger, Option, Ref, References, Schema, Stream } from "effect"
import type { Result } from "effect"
import {
  ActionPolicy,
  ConversationId,
  ConversationMemory,
  CurrentAgentStep,
  CurrentToolInvocation,
  defineCapability,
  defineSkill,
  defineTool,
  EntryId,
  Failure,
  FileSystem,
  harnessCodeOf,
  harnessDefectsAsFailures,
  HarnessError,
  IntentMatcher,
  InvocationId,
  isHarnessError,
  journalSchemaOf,
  Media,
  mediaFromBase64,
  openLogSession,
  publishToolProgress,
  RunContext,
  RunId,
  SessionEnvironment,
  ToolRegistry,
  TurnMemory,
  turnStartedDraft,
  TurnToolbox,
  UserMessage,
} from "@xandreed/core"
import { TurnLive } from "@xandreed/core/engine"
import type { Capability, MemoryPolicy, RunTools, SessionLogEvent, ToolInvocation, ToolRefusalReason, TurnDraft, TurnError, TurnEvent, TurnWriter } from "@xandreed/core"
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
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
  digestOnWrite: Option.none(),
  maintain: () => Effect.succeed({ actions: [], digest: [] }),
}

/** A writer that stores the turn's events in memory: what the session would journal. With `refuses`, it fails to store that kind. */
const recordingWriter = (refuses: Option.Option<string> = Option.none()) => Effect.gen(function* () {
  const session = ConversationId.make("00000000-0000-4000-8000-0000000000aa")
  const userMessage = new UserMessage({ text: "build it" })
  const draft = yield* turnStartedDraft(1, {
    runId: RunId.make("run-1"), key: "run-1", origin: "user", userMessage, command: {}, claimed: [], entry: EntryId.make("run-1:0"), at: 0,
  }).pipe(Effect.orDie)
  const started: SessionLogEvent = { session, seq: 1, turn: draft.turn, kind: draft.kind, at: 0, data: draft.data }
  const stored = yield* Ref.make<ReadonlyArray<SessionLogEvent>>([started])
  const append = (drafts: ReadonlyArray<TurnDraft>) => drafts.some((next) => Option.contains(refuses, next.kind))
    ? Effect.fail(new HarnessError({ code: "store.unavailable", message: "the store is unavailable" }))
    : Ref.update(stored, (all) => [...all, ...drafts.map((next, index): SessionLogEvent => ({
      session, seq: all.length + index + 1, turn: Option.some(1), kind: next.kind, at: 0, data: next.data,
    }))])
  const writer: TurnWriter = {
    admitted: { session: { id: session, owner: "test" }, turn: 1, runId: RunId.make("run-1"), key: "run-1", origin: "user", userMessage, command: {}, claimed: [], meta: {} },
    started,
    history: () => Effect.succeed([]),
    snapshot: () => Ref.get(stored),
    append,
    write: (op) => op,
    transact: (decide) => decide([]).pipe(Effect.flatMap((decision) => append(decision.drafts).pipe(Effect.as({ result: decision.result, events: [] })))),
    flush: Effect.void,
    closing: () => Effect.void,
    end: () => Effect.succeed({ pending: 0 }),
    closed: Effect.never,
  }
  return { writer, stored: Ref.get(stored), kinds: Ref.get(stored).pipe(Effect.map((all) => all.map((event) => event.kind))) }
})

/**
 * One turn over the real registry: open the tools (inside `outer`, as a
 * nested agent opened by another tool's handler would), call the tool at
 * step 2, and return how the call ended (a turn failure restored as at the
 * turn boundary), what the handler saw, what the bus carried and what was
 * stored. With `failOn`, an inline subscriber fails on that event.
 */
const callInTurn = (outer: Option.Option<ToolInvocation>, failOn: Option.Option<TurnEvent["_tag"]> = Option.none()) => Effect.scoped(Effect.gen(function* () {
  const recorded = yield* recordingWriter()
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
      const kit = yield* tools.toolkit.pipe(Effect.provide(tools.handlers))
      return yield* Stream.runCollect(yield* kit.handle(Report.name, {}))
    }) as never
    const outcome = yield* harnessDefectsAsFailures(handled.pipe(Effect.provideService(CurrentAgentStep, Option.some(2)), Effect.provideService(CurrentToolInvocation, outer))).pipe(Effect.result)
    yield* run.flush
    const events = (yield* Ref.get(published)).filter((event) => event._tag.startsWith("tool."))
    return {
      saw: outcome._tag === "Success" ? outcome.success.at(-1)?.result : undefined,
      failure: outcome._tag === "Failure" && isHarnessError(outcome.failure) ? `${outcome.failure.code}: ${outcome.failure.message}` : "none",
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
      { _tag: "tool.progress", step: 2, invocationId: InvocationId.make("run-1:call:0"), tool: "report_progress", channel: "stdout", text: "compiling" },
      { _tag: "tool.progress", step: 2, invocationId: InvocationId.make("run-1:call:0"), tool: "report_progress", channel: "status", text: "1 of 2" },
    ])
    expect(turn.stored).toContain("tool.started")
    expect(turn.stored).toContain("tool.completed")
    expect(turn.stored).not.toContain("tool.progress")
  })

  test("the invocation is provided innermost: a handler sees its own call even under another tool's", async () => {
    const outer = Option.some({ invocationId: InvocationId.make("outer-run:call:7"), tool: "delegate", step: 5 })
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

/* ── refusals: calls the registry refuses before the handler runs ── */

const Vault = Tool.make("read_vault", {
  description: "Read the vault.",
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const Ping = Tool.make("ping", {
  description: "Answer pong.",
  parameters: Schema.Struct({ n: Schema.Int }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const Archive = Tool.make("archive", {
  description: "Archive a record.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

/** `ping` is always on, at most twice per turn; `read_vault` needs a grant; `archive` comes with a skill nobody loads. */
const guarded = defineCapability({
  id: "guarded",
  version: "1",
  tools: [
    defineTool({ tool: Ping, handler: ({ n }) => Effect.succeed(`pong ${n}`), annotations: { maxCallsPerRun: Option.some(2) } }),
    defineTool({ tool: Vault, handler: ({ key }) => Effect.succeed(`secret ${key}`), annotations: { permissions: ["vault.read"] } }),
    defineTool({ tool: Archive, handler: ({ id }) => Effect.succeed(`archived ${id}`) }),
  ],
  skills: [
    defineSkill({ id: "basics", summary: "Ping.", tools: [Ping.name], always: true }),
    defineSkill({ id: "vault", summary: "Read the vault.", tools: [Vault.name], permissions: ["vault.read"] }),
    defineSkill({ id: "archiving", summary: "Archive records.", tools: [Archive.name] }),
  ],
})

interface Refusals {
  /** What each call returned to the model: its result, or its failure. */
  readonly results: ReadonlyArray<unknown>
  readonly events: ReadonlyArray<TurnEvent>
  readonly stored: ReadonlyArray<SessionLogEvent>
}

/**
 * One turn over the real registry, calling tools through the open toolkit's
 * handlers directly (at step 1), as a host or another tool would: the model
 * is only ever offered the active tools. `vaultActive` records `read_vault`
 * as activated by an earlier turn, as a turn whose grants have since changed
 * would find it.
 */
const refusalTurn = (calls: ReadonlyArray<readonly [string, unknown]>, options: {
  readonly config?: Partial<DiscoveryConfig>
  readonly policy?: typeof ActionPolicy.Service
  readonly vaultActive?: boolean
  readonly capabilities?: ReadonlyArray<Capability>
} = {}): Effect.Effect<Refusals> => Effect.scoped(Effect.gen(function* () {
  const recorded = yield* recordingWriter()
  const registry = yield* makeRegistry({ ...config, ...options.config }, options.capabilities ?? [guarded])
  const services = Layer.merge(
    Layer.succeed(ConversationMemory, ConversationMemory.of({ strategy: policy.strategy, open: ({ runId, log }) => openLogSession(log, policy, { runId }) })),
    Layer.succeed(ToolRegistry, ToolRegistry.of({ catalog: registry.catalog, open: registry.open })),
  )
  return yield* Effect.gen(function* () {
    const run = yield* RunContext
    const published = yield* Ref.make<ReadonlyArray<TurnEvent>>([])
    yield* run.events.subscribe(Option.some, (event) => Ref.update(published, (all) => [...all, event]))
    const memory = yield* TurnMemory
    yield* memory.persistMessage
    if (options.vaultActive === true) {
      yield* memory.session.record([{ _tag: "ToolsActivated", skills: ["vault"], tools: [Vault.name], source: "host", decision: Option.none() }], 0)
    }
    const opening = (yield* TurnToolbox).open
    const tools = yield* (options.policy === undefined ? opening : opening.pipe(Effect.provideService(ActionPolicy, options.policy)))
    yield* tools.select(run.userMessage)
    const handled = (name: string, params: unknown): Effect.Effect<unknown> => Effect.gen(function* () {
      const kit = yield* tools.toolkit.pipe(Effect.provide(tools.handlers))
      const results = yield* Stream.runCollect(yield* kit.handle(name, params))
      return results.at(-1)?.result
    }).pipe(Effect.provideService(CurrentAgentStep, Option.some(1)), Effect.orDie) as never
    const results = yield* Effect.forEach(calls, ([name, params]) => handled(name, params))
    yield* run.flush
    return {
      results,
      events: (yield* Ref.get(published)).filter((event) => event._tag.startsWith("tool.")),
      stored: (yield* recorded.stored).filter((event) => event.kind.startsWith("tool.")),
    } satisfies Refusals
  }).pipe(Effect.provide(TurnLive({ turn: recorded.writer })), Effect.provide(services))
}).pipe(Effect.orDie))

const refusedEvents = (turn: Refusals) => turn.events.flatMap((event) => event._tag === "tool.refused" ? [event] : [])

describe("the registry refuses a call before its handler runs", () => {
  const cases: Array<{
    readonly reason: ToolRefusalReason
    readonly error: string
    /** The refusal's text, as the model reads it. */
    readonly message: string
    readonly calls: ReadonlyArray<readonly [string, unknown]>
    readonly options?: Parameters<typeof refusalTurn>[1]
    /** The refused call's position: earlier calls ran. */
    readonly refusedAt: number
  }> = [
    { reason: "inactive", error: "ToolInactive", message: "archive is not loaded yet; call load_skill with one of: archiving", calls: [[Archive.name, { id: "r1" }]], refusedAt: 0 },
    { reason: "forbidden", error: "Forbidden", message: "read_vault requires vault.read", calls: [[Vault.name, { key: "k" }]], options: { vaultActive: true }, refusedAt: 0 },
    {
      reason: "denied", error: "Denied", message: "pings are closed today", calls: [[Ping.name, { n: 1 }]], refusedAt: 0,
      options: { policy: { authorize: (tool) => tool === Ping.name ? Effect.fail(new HarnessError({ code: "policy.closed", message: "pings are closed today" })) : Effect.void } },
    },
    {
      reason: "call-limit", error: "CallLimit", message: "The turn's 1-call limit is reached; deliver with what you have",
      calls: [[Ping.name, { n: 1 }], [Ping.name, { n: 2 }]], options: { config: { maxCallsPerRun: 1 } }, refusedAt: 1,
    },
    {
      reason: "tool-call-limit", error: "ToolCallLimit", message: "ping may be called at most 2 times per turn; use what its earlier calls returned",
      calls: [[Ping.name, { n: 1 }], [Ping.name, { n: 2 }], [Ping.name, { n: 3 }]], refusedAt: 2,
    },
  ]

  test.each(cases)("$reason: one tool.refused with the call's id and input, no tool.started, the refusal as the call's failed result", async ({ reason, error, message, calls, options, refusedAt }) => {
    const turn = await Effect.runPromise(refusalTurn(calls, options))
    const refused = refusedEvents(turn)
    expect(refused).toHaveLength(1)
    const event = refused[0]!
    const [tool, input] = calls[refusedAt]!
    // The call's id is minted before the checks: earlier calls took 0…refusedAt-1.
    expect(event).toMatchObject({ _tag: "tool.refused", step: 1, invocationId: `run-1:call:${refusedAt}`, tool, input, reason, message })
    expect(turn.results[refusedAt]).toEqual({ error, message })
    // Earlier calls ran (started, completed); the refused one has only its refusal.
    expect(turn.events.filter((other) => other._tag === "tool.started" || other._tag === "tool.completed").map((other): string => other._tag === "tool.started" || other._tag === "tool.completed" ? other.invocationId : ""))
      .toEqual(Array.from({ length: refusedAt }, (_, index) => [`run-1:call:${index}`, `run-1:call:${index}`]).flat())
    expect(turn.events.some((other) => other._tag !== "tool.refused" && "invocationId" in other && other.invocationId === event.invocationId)).toBe(false)
  })

  test.each(cases)("$reason: journaled as tool.refused without its input", async ({ calls, options }) => {
    const turn = await Effect.runPromise(refusalTurn(calls, options))
    const stored = turn.stored.filter((event) => event.kind === "tool.refused")
    expect(stored).toHaveLength(1)
    expect(Object.keys(stored[0]!.data).sort()).toEqual(["invocationId", "message", "reason", "step", "tool"])
    const schema = Option.getOrThrow(journalSchemaOf("tool.refused"))
    expect(Option.isSome(Schema.decodeUnknownOption(schema)(stored[0]!.data))).toBe(true)
  })

  test("the denial's message is the host's", async () => {
    const turn = await Effect.runPromise(refusalTurn([[Ping.name, { n: 1 }]], {
      policy: { authorize: () => Effect.fail(new HarnessError({ code: "policy.closed", message: "pings are closed today" })) },
    }))
    expect(refusedEvents(turn).map((event) => event.message)).toEqual(["pings are closed today"])
  })

  test("a tool no skill provides is refused as not available, with no skill to load", async () => {
    const Stray = Tool.make("stray", { description: "Wander off.", parameters: Schema.Struct({}), success: Schema.String, failure: Failure, failureMode: "return" })
    const stray = defineCapability({ id: "stray", version: "1", tools: [defineTool({ tool: Stray, handler: () => Effect.succeed("wandered") })] })
    const turn = await Effect.runPromise(refusalTurn([[Stray.name, {}]], { capabilities: [guarded, stray] }))
    expect(turn.results).toEqual([{ error: "ToolInactive", message: "stray is not available in this conversation" }])
  })

  test("an allowed call publishes no tool.refused, and its id follows the refused ones", async () => {
    const turn = await Effect.runPromise(refusalTurn([[Archive.name, { id: "r1" }], [Ping.name, { n: 1 }]]))
    expect(turn.results).toEqual([expect.objectContaining({ error: "ToolInactive" }), "pong 1"])
    expect(turn.events.map((event) => `${event._tag}:${"invocationId" in event ? event.invocationId : ""}`)).toEqual([
      "tool.refused:run-1:call:0", "tool.started:run-1:call:1", "tool.completed:run-1:call:1",
    ])
  })
})

describe("opening a run's tools", () => {
  const Look = Tool.make("look", { description: "Name the workspace.", parameters: Schema.Struct({}), success: Schema.String, failure: Failure, failureMode: "return" })
  const Touch = Tool.make("touch", { description: "Touch the workspace.", parameters: Schema.Struct({}), success: Schema.String, failure: Failure, failureMode: "return" })
  const declaring = defineCapability({
    id: "declaring", version: "1",
    tools: [
      defineTool({ tool: Look, requires: [SessionEnvironment], handler: () => SessionEnvironment.pipe(Effect.map((environment) => environment.workspace)) }),
      defineTool({ tool: Touch, requires: [FileSystem, SessionEnvironment], handler: () => Effect.all([FileSystem, SessionEnvironment], { concurrency: 1 }).pipe(Effect.as("touched")) }),
    ],
    skills: [defineSkill({ id: "declaring", summary: "Look and touch.", tools: [Look.name, Touch.name], always: true })],
  })

  test("fails with requires.missing, naming each tool and each service it declares that the run lacks, before any step", async () => {
    const error = await Effect.runPromise(Effect.flip(harnessDefectsAsFailures(refusalTurn([], { capabilities: [declaring] }))))
    expect([harnessCodeOf(error), isHarnessError(error) ? error.message : "none"]).toEqual([
      Option.some("requires.missing"), "look requires efferent/SessionEnvironment; touch requires @xandreed/core/FileSystem, efferent/SessionEnvironment",
    ])
  })
})

describe("a handler that dies", () => {
  const Crash = Tool.make("crash", { description: "Always dies.", parameters: Schema.Struct({}), success: Schema.String, failure: Failure, failureMode: "return" })
  // Made here, so its stack names this file: none of it may reach the model, the bus or the journal.
  const defect = new Error("disk on fire\nwhile writing the cache")
  const crashing = defineCapability({
    id: "crashing", version: "1",
    tools: [defineTool({ tool: Crash, handler: () => Effect.die(defect) })],
    skills: [defineSkill({ id: "crashing", summary: "Crash.", tools: [Crash.name], always: true })],
  })

  test("returns the first line of its message as a ToolDefect, with no stack frame or path, and logs the whole cause", async () => {
    const logged: Array<{ readonly message: string; readonly cause: Cause.Cause<unknown>; readonly annotations: Readonly<Record<string, unknown>> }> = []
    const capture = Logger.layer([Logger.make((options) => logged.push({
      message: [options.message].flat().join(" "), cause: options.cause, annotations: options.fiber.getRef(References.CurrentLogAnnotations),
    }))])
    const turn = await Effect.runPromise(refusalTurn([[Crash.name, {}]], { capabilities: [crashing] }).pipe(Effect.provide(capture)))
    expect(turn.results).toEqual([{ error: "ToolDefect", message: "crash failed unexpectedly: disk on fire" }])
    const completed = turn.events.find((event) => event._tag === "tool.completed")
    expect(completed).toMatchObject({ ok: false, result: turn.results[0], encoded: turn.results[0] })
    const written = JSON.stringify([turn.results, turn.events, turn.stored])
    expect(written).not.toContain(import.meta.dir)
    expect(written).not.toContain("registry.adapter.test")
    expect(written).not.toMatch(/\bat\s/)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ message: "crash failed unexpectedly", annotations: { tool: "crash", invocationId: "run-1:call:0" } })
    expect(Cause.squash(logged[0]!.cause)).toBe(defect)
  })
})

/* ── activations that fail: a refusal is the request's, a store failure the turn's ── */

/** `archiving` and `pinging` load freely, `vault` needs a grant the turn lacks; no skill is always on. */
const selectable = defineCapability({
  id: "selectable",
  version: "1",
  tools: [
    defineTool({ tool: Ping, handler: ({ n }) => Effect.succeed(`pong ${n}`) }),
    defineTool({ tool: Vault, handler: ({ key }) => Effect.succeed(`secret ${key}`), annotations: { permissions: ["vault.read"] } }),
    defineTool({ tool: Archive, handler: ({ id }) => Effect.succeed(`archived ${id}`) }),
  ],
  skills: [
    defineSkill({ id: "archiving", summary: "Archive records.", tools: [Archive.name] }),
    defineSkill({ id: "pinging", summary: "Ping.", tools: [Ping.name] }),
    defineSkill({ id: "vault", summary: "Read the vault.", tools: [Vault.name], permissions: ["vault.read"] }),
  ],
})

const message = new UserMessage({ text: "file the records" })

/**
 * One turn over the real registry, its tools opened with a matcher that picks
 * `picks` (one list per match), running `body` over them; a turn failure is
 * restored as at the turn boundary. With `refuses`, the store fails to write
 * that kind. Returns how `body` ended, the decisions published and what memory holds.
 */
const matchedTurn = <A>(
  picks: ReadonlyArray<ReadonlyArray<string>>,
  body: (tools: RunTools) => Effect.Effect<A, TurnError>,
  refuses: Option.Option<string> = Option.none(),
  capabilities: ReadonlyArray<Capability> = [selectable],
) =>
  Effect.scoped(Effect.gen(function* () {
    const recorded = yield* recordingWriter(refuses)
    const registry = yield* makeRegistry(config, capabilities)
    const left = yield* Ref.make(picks)
    const matcher = IntentMatcher.of({
      id: "picking", version: "1",
      match: () => Ref.modify(left, (all) => [{ skills: all[0] ?? [], probabilities: Option.none(), abstained: false }, all.slice(1)]),
    })
    const services = Layer.merge(
      Layer.succeed(ConversationMemory, ConversationMemory.of({ strategy: policy.strategy, open: ({ runId, log }) => openLogSession(log, policy, { runId }) })),
      Layer.succeed(ToolRegistry, ToolRegistry.of({ catalog: registry.catalog, open: registry.open })),
    )
    return yield* Effect.gen(function* () {
      const run = yield* RunContext
      const published = yield* Ref.make<ReadonlyArray<TurnEvent>>([])
      yield* run.events.subscribe(Option.some, (event) => Ref.update(published, (all) => [...all, event]))
      const memory = yield* TurnMemory
      yield* memory.persistMessage
      const tools = yield* (yield* TurnToolbox).open.pipe(Effect.provideService(IntentMatcher, matcher))
      const outcome = yield* Effect.result(harnessDefectsAsFailures(body(tools)))
      yield* run.flush
      return {
        outcome,
        decisions: (yield* Ref.get(published)).flatMap((event) => event._tag === "decision.recorded" ? [event.record] : []),
        entries: yield* memory.session.entries,
      }
    }).pipe(Effect.provide(TurnLive({ turn: recorded.writer })), Effect.provide(services))
  }).pipe(Effect.orDie))

/** Call a tool through the open toolkit's handlers at step 1, as the loop does; the call's result, failed or not. */
const callTool = (tools: RunTools, name: string, params: unknown): Effect.Effect<unknown, HarnessError> => Effect.gen(function* () {
  const kit = yield* tools.toolkit.pipe(Effect.provide(tools.handlers))
  const results = yield* Stream.runCollect(yield* kit.handle(name, params))
  return results.at(-1)?.result
}).pipe(Effect.provideService(CurrentAgentStep, Option.some(1))) as never

const codeOf = <A>(outcome: Result.Result<A, TurnError>): string => outcome._tag === "Failure" ? Option.getOrElse(harnessCodeOf(outcome.failure), () => outcome.failure._tag) : `succeeded with ${JSON.stringify(outcome.success)}`

describe("the matcher's choice, applied", () => {
  test("a skill the turn may not use is refused, and the decision recorded as rejected", async () => {
    const turn = await Effect.runPromise(matchedTurn([["vault"]], (tools) => tools.select(message)))
    expect(turn.outcome._tag).toBe("Success")
    expect(turn.decisions.map((record) => [record.validation, Option.getOrNull(record.applied)])).toEqual([["rejected", null]])
  })

  test("a store failure while activating it fails the apply, and is never recorded as a rejection", async () => {
    const turn = await Effect.runPromise(matchedTurn([["archiving"]], (tools) => tools.select(message), Option.some("memory.skills")))
    expect(codeOf(turn.outcome)).toBe("store.unavailable")
    expect(turn.decisions).toEqual([])
  })

  test("each decision of a run, and each load_skill exchange seeded from one, takes an id of its own", async () => {
    const turn = await Effect.runPromise(matchedTurn([["archiving"], ["pinging"]], (tools) => tools.select(message).pipe(Effect.andThen(tools.select(message)))))
    expect(turn.decisions.map((record) => [String(record.id), record.validation])).toEqual([
      ["run-1:skill-selection:0", "accepted"], ["run-1:skill-selection:1", "accepted"],
    ])
    const seeded = turn.entries.flatMap((entry) => entry.body._tag === "ToolResult" ? [String(entry.body.toolCallId)] : [])
    expect(seeded).toEqual(["run-1:matcher:0", "run-1:matcher:1"])
  })
})

/** What `body` succeeded with, or its failure's code. */
const successOf = <A>(outcome: Result.Result<A, TurnError>): A | string => outcome._tag === "Success" ? outcome.success : codeOf(outcome)

describe("load_skill", () => {
  test("a skill the turn may not use is refused as the call's result, for the model to correct", async () => {
    const turn = await Effect.runPromise(matchedTurn([], (tools) => callTool(tools, "load_skill", { skills: ["vault"] })))
    expect(successOf(turn.outcome)).toEqual({ error: "capability.forbidden", message: "Selection requires permissions this run was not granted (read_vault needs vault.read); it cannot be loaded in this run" })
  })

  test("skills the catalogue lacks are refused, each named", async () => {
    const turn = await Effect.runPromise(matchedTurn([], (tools) => callTool(tools, "load_skill", { skills: ["filing", "archiving", "sorting"] })))
    expect(successOf(turn.outcome)).toEqual({ error: "skills.unknown", message: "Unknown skills: filing, sorting; load_skill takes the skills the catalogue lists" })
  })

  test("a load past the turn's limit is refused with the limit", async () => {
    const loads = Array.from({ length: config.maxSkillLoadsPerRun + 1 }, () => ({ skills: ["pinging"] }))
    const turn = await Effect.runPromise(matchedTurn([], (tools) => Effect.forEach(loads, (params) => callTool(tools, "load_skill", params), { concurrency: 1 }).pipe(
      Effect.map((results) => results.at(-1)))))
    expect(successOf(turn.outcome)).toEqual({ error: "SkillLoadLimit", message: "At most 4 skill loads per turn; work with the tools already loaded" })
  })

  test("a store failure while activating fails the turn, and never reaches the model as the call's result", async () => {
    const turn = await Effect.runPromise(matchedTurn([], (tools) => callTool(tools, "load_skill", { skills: ["archiving"] }), Option.some("memory.skills")))
    expect(codeOf(turn.outcome)).toBe("store.unavailable")
  })
})

/** `archiving` ships one reference. */
const referenced = defineCapability({
  id: "referenced",
  version: "1",
  tools: [defineTool({ tool: Archive, handler: ({ id }) => Effect.succeed(`archived ${id}`) })],
  skills: [defineSkill({
    id: "archiving", summary: "Archive records.", tools: [Archive.name],
    references: [{ id: "retention", title: "Retention rules", text: "Keep records seven years." }],
  })],
})

describe("the registry's own tools", () => {
  test("load_skill always, read_skill_reference once a skill ships references, each with its description", async () => {
    const own = (capabilities: ReadonlyArray<Capability>) => Effect.runPromise(matchedTurn([], (tools) => Effect.succeed(Object.values(tools.toolkit.tools).flatMap((tool) =>
      tool.name === "load_skill" || tool.name === "read_skill_reference" ? [[tool.name, tool.description]] : [])), Option.none(), capabilities))
    const loadSkill = ["load_skill", "Load one or more skills from the catalogue: returns their instructions and makes their tools available from the next step. Load a skill before doing work it covers."]
    expect(successOf((await own([selectable])).outcome)).toEqual([loadSkill])
    expect(successOf((await own([referenced])).outcome)).toEqual([loadSkill, ["read_skill_reference", "Read one reference document listed by a loaded skill."]])
  })

  test("read_skill_reference reads a reference of a loaded skill, and refuses one of a skill not loaded or not listed", async () => {
    const calls: ReadonlyArray<readonly [string, unknown]> = [
      ["read_skill_reference", { skill: "archiving", reference: "retention" }],
      ["load_skill", { skills: ["archiving"] }],
      ["read_skill_reference", { skill: "archiving", reference: "purge" }],
      ["read_skill_reference", { skill: "archiving", reference: "retention" }],
    ]
    const turn = await Effect.runPromise(matchedTurn([], (tools) => Effect.forEach(calls, ([name, params]) => callTool(tools, name, params), { concurrency: 1 }), Option.none(), [referenced]))
    expect(successOf(turn.outcome)).toEqual([
      { error: "SkillNotLoaded", message: "Load archiving with load_skill first" },
      "## archiving\nArchive records.\nTools: archive\nReferences (read_skill_reference): retention — Retention rules\n\nNow available: archive",
      { error: "UnknownReference", message: "archiving has no reference purge" },
      "Keep records seven years.",
    ])
  })
})

describe("the views of a result holding images", () => {
  const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  const pixelGif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
  const Shots = Tool.make("shots", {
    description: "Two screenshots.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({ before: Media, after: Media }),
    failure: Failure,
    failureMode: "return",
  })
  const Raw = Tool.make("raw_shots", { description: "Two screenshots, no view.", parameters: Schema.Struct({}), success: Schema.Struct({ before: Media, after: Media }), failure: Failure, failureMode: "return" })
  const capability = defineCapability({
    id: "shots", version: "1",
    tools: [
      defineTool({ tool: Shots, handler: () => Effect.die("unused"), view: { version: "1", render: () => "after the click", media: (result) => [result.after] } }),
      defineTool({ tool: Raw, handler: () => Effect.die("unused") }),
    ],
  })
  const views = Effect.runSync(Effect.gen(function* () {
    const registry = yield* makeRegistry(config, [capability])
    return registry.views
  }))
  const encoded = Effect.runSync(Effect.all({ before: mediaFromBase64(pixelPng), after: mediaFromBase64(pixelGif) }))

  test("the raw view shows the result with each image's data elided, and sends every image", () => {
    const view = Effect.runSync(views.view("raw_shots", encoded, {}, false))
    expect(view.text).not.toContain(pixelPng.slice(0, 30))
    expect(view.text).toContain(String(encoded.before.fingerprint))
    expect(view.media?.map((slot) => slot.path)).toEqual([["after"], ["before"]])
  })

  test("a view's selector picks the images it sends among the result's; a failed call sends none", () => {
    const view = Effect.runSync(views.view("shots", encoded, {}, false))
    expect([view.text, view.media?.map((slot) => slot.path)]).toEqual(["after the click", [["after"]]])
    expect(Effect.runSync(views.view("shots", encoded, {}, true)).media).toBeUndefined()
    expect(Effect.runSync(views.view("raw_shots", encoded, {}, true)).media).toBeUndefined()
  })
})

describe("a tool's digest task", () => {
  const Search = Tool.make("search", {
    description: "Search records.",
    parameters: Schema.Struct({ query: Schema.String }),
    success: Schema.Struct({ ids: Schema.Array(Schema.String), text: Schema.String }),
    failure: Failure,
    failureMode: "return",
  })
  const capability = defineCapability({
    id: "search", version: "1",
    tools: [defineTool({
      tool: Search, handler: () => Effect.die("unused"),
      view: { version: "1", render: (result) => result.text, digest: { _tag: "Summarize", version: "1", instructions: "Summarize the matches.", preserve: (result) => result.ids } },
    })],
  })
  const views = Effect.runSync(makeRegistry(config, [capability]).pipe(Effect.map((registry) => registry.views)))

  test("a summarize task carries the identifiers its summary must keep, which the digester shows its model", () => {
    const found = Effect.runSync(views.digest("search", { ids: ["r-1", "r-2"], text: "r-1 and r-2 matched" }, { query: "r" }, new UserMessage({ text: "find r" })))
    expect(Option.map(found, (task) => [task.mode, task.preserve, task.source])).toEqual(Option.some(["summarize", ["r-1", "r-2"], "r-1 and r-2 matched"]))
    const task = Option.getOrThrow(found)
    expect(task.apply({ keep: [], summary: Option.some("r-1 matched") })).toEqual(Option.none())
    expect(task.apply({ keep: [], summary: Option.some("r-1 and r-2 matched") })).toEqual(Option.some("r-1 and r-2 matched"))
  })
})
