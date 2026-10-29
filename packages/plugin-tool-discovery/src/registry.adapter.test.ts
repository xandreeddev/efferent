import { describe, expect, test } from "bun:test"
import { Tool } from "effect/ai"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import type { Context } from "effect"
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
  HarnessError,
  harnessDefectsAsFailures,
  journalSchemaOf,
  Media,
  mediaFromBase64,
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
import type { Capability, MemoryPolicy, SessionLogEvent, ToolInvocation, ToolRefusalReason, TurnDraft, TurnEvent, TurnWriter } from "@xandreed/core"
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
  const recorded = yield* recordingWriter
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
      const kit = yield* tools.toolkit.pipe(Effect.provide(tools.handlers as Context.Context<Tool.HandlersFor<Record<string, Tool.Any>>>))
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
    readonly calls: ReadonlyArray<readonly [string, unknown]>
    readonly options?: Parameters<typeof refusalTurn>[1]
    /** The refused call's position: earlier calls ran. */
    readonly refusedAt: number
  }> = [
    { reason: "inactive", error: "ToolInactive", calls: [[Archive.name, { id: "r1" }]], refusedAt: 0 },
    { reason: "forbidden", error: "Forbidden", calls: [[Vault.name, { key: "k" }]], options: { vaultActive: true }, refusedAt: 0 },
    {
      reason: "denied", error: "Denied", calls: [[Ping.name, { n: 1 }]], refusedAt: 0,
      options: { policy: { authorize: (tool) => tool === Ping.name ? Effect.fail(new HarnessError({ code: "policy.closed", message: "pings are closed today" })) : Effect.void } },
    },
    { reason: "call-limit", error: "CallLimit", calls: [[Ping.name, { n: 1 }], [Ping.name, { n: 2 }]], options: { config: { maxCallsPerRun: 1 } }, refusedAt: 1 },
    { reason: "tool-call-limit", error: "ToolCallLimit", calls: [[Ping.name, { n: 1 }], [Ping.name, { n: 2 }], [Ping.name, { n: 3 }]], refusedAt: 2 },
  ]

  test.each(cases)("$reason: one tool.refused with the call's id and input, no tool.started, the refusal as the call's failed result", async ({ reason, error, calls, options, refusedAt }) => {
    const turn = await Effect.runPromise(refusalTurn(calls, options))
    const refused = refusedEvents(turn)
    expect(refused).toHaveLength(1)
    const event = refused[0]!
    const [tool, input] = calls[refusedAt]!
    // The call's id is minted before the checks: earlier calls took 0…refusedAt-1.
    expect(event).toMatchObject({ _tag: "tool.refused", step: 1, invocationId: `run-1:call:${refusedAt}`, tool, input, reason })
    expect(turn.results[refusedAt]).toEqual({ error, message: event.message })
    // Earlier calls ran (started, completed); the refused one has only its refusal.
    expect(turn.events.filter((other) => other._tag === "tool.started" || other._tag === "tool.completed").map((other) => other._tag === "tool.started" || other._tag === "tool.completed" ? other.invocationId : ""))
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

  test("an allowed call publishes no tool.refused, and its id follows the refused ones", async () => {
    const turn = await Effect.runPromise(refusalTurn([[Archive.name, { id: "r1" }], [Ping.name, { n: 1 }]]))
    expect(turn.results).toEqual([expect.objectContaining({ error: "ToolInactive" }), "pong 1"])
    expect(turn.events.map((event) => `${event._tag}:${"invocationId" in event ? event.invocationId : ""}`)).toEqual([
      "tool.refused:run-1:call:0", "tool.started:run-1:call:1", "tool.completed:run-1:call:1",
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
