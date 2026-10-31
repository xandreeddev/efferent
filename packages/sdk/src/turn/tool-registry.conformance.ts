import { Tool } from "effect/ai"
import { Array as Arr, Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Scheduler, Schema, Stream } from "effect"
import type { Scope } from "effect"
import {
  ActionPolicy,
  ConversationId,
  ConversationMemory,
  CurrentAgentRun,
  CurrentAgentStep,
  CurrentToolInvocation,
  defineCapability,
  defineSkill,
  defineTool,
  EntryId,
  Failure,
  harnessCodeOf,
  HarnessError,
  openLogSession,
  PermissionGrants,
  publishToolProgress,
  RunContext,
  RunId,
  RunOrdinal,
  SessionEnvironment,
  SessionLogError,
  storedJson,
  ToolRegistry,
  ToolInterceptor,
  TurnMemory,
  turnStartedDraft,
  TurnToolbox,
  UserMessage,
} from "@xandreed/core"
import type {
  Capability,
  CapabilityCatalog,
  BeforeToolDecision,
  AfterToolDecision,
  MemoryPolicy,
  RunTools,
  SessionLogEvent,
  ToolRefusalReason,
  TurnDraft,
  TurnEvent,
  TurnError,
  TurnWriter,
} from "@xandreed/core"
import { check, ConformanceFailure } from "@xandreed/core/conformance"
import type { ConformanceCheck } from "@xandreed/core/conformance"
import { randomUuid } from "@xandreed/core/internal"
import { TurnLive } from "./turn.adapter.js"

type Registry = Context.Service.Shape<typeof ToolRegistry>

const fail = (check: string, message: string) => Effect.fail(new ConformanceFailure({ check, message }))
const expect = (check: string, holds: boolean, message: string): Effect.Effect<void, ConformanceFailure> => holds ? Effect.void : fail(check, message)
/** A port's failure as the kit compares and reports it: its framework code (`harnessCodeOf`), else its tag. */
const failureCode = (error: { readonly _tag: string }): string => Option.getOrElse(harnessCodeOf(error), () => error._tag)
/** A fresh session id per turn, so the kit can run against a shared store. */
const freshId = Effect.map(randomUuid, (id) => ConversationId.make(id))

/**
 * What the kit asks of the registry it builds: the most calls a turn may make.
 *
 * @public
 */
export interface ToolRegistryLimits {
  readonly maxCallsPerRun: number
  readonly readConcurrency?: number
  readonly toolPolicy?: Readonly<Record<string, {
    readonly concurrency?: number
    readonly maxCallsPerRun?: number
    readonly breakAfter?: number
    readonly breakOn?: "defects" | "failures"
  }>>
}

/** The run the kit's turns are, as its invocation ids name it. */
const RUN = RunId.make("conformance-run")

/** A service of whoever opens the tools, which the handlers must see (and not the caller's). */
const Opener = Context.Reference<string>("efferent/conformance/ToolRegistryOpener", { defaultValue: () => "none" })
/** What a handler can prove was flushed before it ran. */
const DurableStarted = Context.Reference<Effect.Effect<boolean>>("efferent/conformance/ToolRegistryDurableStarted", { defaultValue: () => Effect.succeed(false) })
const ExecutionProbe = Context.Reference<(tool: string) => Effect.Effect<void>>("@xandreed/sdk/conformance/RegistryExecutionProbe", { defaultValue: () => () => Effect.void })

const Ping = Tool.make("kit_ping", {
  description: "Answer pong, at most twice per turn.",
  parameters: Schema.Struct({ n: Schema.Int }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const Report = Tool.make("kit_report", {
  description: "Report progress twice, then say which call this was.",
  parameters: Schema.Struct({}),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const Durability = Tool.make("kit_durability", {
  description: "Say whether this call's start was durably flushed before the handler ran.",
  parameters: Schema.Struct({}), success: Schema.Boolean, failure: Failure, failureMode: "return",
})
const Where = Tool.make("kit_where", {
  description: "Say which workspace the call runs in.",
  parameters: Schema.Struct({}),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const Vault = Tool.make("kit_vault", {
  description: "Read the vault, with the kit.vault permission.",
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const Archive = Tool.make("kit_archive", {
  description: "Archive a record, once its skill is loaded.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const Flaky = Tool.make("kit_flaky", {
  description: "Exercise handler failures.", parameters: Schema.Struct({ outcome: Schema.Literals(["success", "failure", "defect"]) }),
  success: Schema.String, failure: Failure, failureMode: "return",
})
const TOOLS = [Ping.name, Report.name, Durability.name, Where.name, Vault.name, Archive.name, Flaky.name]
const SKILLS = ["kit.basics", "kit.vault", "kit.archiving"]

/**
 * The kit's tools and skills; each handler adds its tool's name to `ran`
 * when it runs. `kit_where` declares the one service it reads, the
 * `SessionEnvironment`, which the kit's turns open the tools with.
 */
const capabilityOf = (ran: Ref.Ref<ReadonlyArray<string>>): Capability => {
  const note = (tool: string) => Ref.update(ran, (all) => [...all, tool])
  return defineCapability({
    id: "conformance.tools",
    version: "1",
    tools: [
      defineTool({ tool: Flaky, handler: ({ outcome }) => note(Flaky.name).pipe(Effect.andThen(Effect.service(ExecutionProbe)), Effect.flatMap((probe) => probe(Flaky.name)), Effect.andThen(outcome === "defect" ? Effect.die(new Error("broken handler")) : outcome === "failure" ? Effect.fail({ error: "ToolFailed", message: "try a different input" }) : Effect.succeed("ok"))) }),
      defineTool({ tool: Durability, handler: () => Effect.service(DurableStarted).pipe(Effect.flatten) }),
      defineTool({ tool: Ping, handler: ({ n }) => note(Ping.name).pipe(Effect.as(`pong ${n}`)), annotations: { maxCallsPerRun: Option.some(2) } }),
      defineTool({
        tool: Report,
        handler: () => Effect.gen(function* () {
          yield* note(Report.name)
          const invocation = yield* Effect.service(CurrentToolInvocation)
          const opener = yield* Effect.service(Opener)
          yield* publishToolProgress("stdout", "working")
          yield* publishToolProgress("status", "half way")
          const provider = Option.flatMap(invocation, (call) => Option.fromNullishOr(call.toolCallId))
          return `${Option.match(invocation, { onNone: () => "no invocation", onSome: (call) => `${call.invocationId}|${call.tool}|${call.step}` })}|${opener}${Option.match(provider, { onNone: () => "", onSome: (id) => `|${id}` })}`
        }),
      }),
      defineTool({
        tool: Where,
        requires: [SessionEnvironment],
        annotations: { readOnly: true },
        handler: () => note(Where.name).pipe(Effect.andThen(Effect.service(ExecutionProbe)), Effect.flatMap((probe) => probe(Where.name)), Effect.andThen(SessionEnvironment), Effect.map((environment) => environment.workspace)),
      }),
      defineTool({ tool: Vault, handler: ({ key }) => note(Vault.name).pipe(Effect.as(`secret ${key}`)), annotations: { permissions: ["kit.vault"] } }),
      defineTool({ tool: Archive, handler: ({ id }) => note(Archive.name).pipe(Effect.as(`archived ${id}`)) }),
    ],
    skills: [
      defineSkill({ id: "kit.basics", summary: "Ping, report and say where.", tools: [Ping.name, Report.name, Durability.name, Where.name, Flaky.name], always: true }),
      defineSkill({ id: "kit.vault", summary: "Read the vault.", tools: [Vault.name], permissions: ["kit.vault"] }),
      defineSkill({ id: "kit.archiving", summary: "Archive records.", tools: [Archive.name] }),
    ],
  })
}

/** A memory that keeps everything and renders it plainly: the kit tests the registry, not memory. */
const policy: MemoryPolicy = {
  strategy: { id: "conformance", version: "1" },
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
  digestOnWrite: Option.none(),
  maintain: () => Effect.succeed({ actions: [], digest: [] }),
}

/**
 * The writer of the kit's turn (turn 1 of a session of its own): it keeps
 * what the turn stores in memory, writes at once but yields first, as
 * storage does (so concurrent calls interleave at their writes), stores the
 * closing drafts it holds when the turn ends, and is never closed from
 * outside.
 */
const memoryWriter = Effect.gen(function* () {
  const session = yield* freshId
  const userMessage = new UserMessage({ text: "use the tools" })
  const draft = yield* turnStartedDraft(1, {
    runId: RUN, key: RUN, origin: "user", userMessage, command: {}, claimed: [], entry: EntryId.make(`${RUN}:0`), at: 0,
  }).pipe(Effect.orDie)
  const started: SessionLogEvent = { session, seq: 1, turn: draft.turn, kind: draft.kind, at: 0, data: draft.data }
  const stored = yield* Ref.make<ReadonlyArray<SessionLogEvent>>([started])
  const flushed = yield* Ref.make<ReadonlyArray<SessionLogEvent>>([started])
  const append = (drafts: ReadonlyArray<TurnDraft>) => Effect.yieldNow.pipe(
    Effect.andThen(Effect.forEach(drafts, (next) => storedJson(next.data), { concurrency: 1 })),
    Effect.mapError((error) => new HarnessError({ code: "session.encode", message: error.message })),
    Effect.flatMap((data) => Ref.update(stored, (all) => [...all, ...Arr.zip(drafts, data).map(([next, json], index): SessionLogEvent => ({
      session, seq: all.length + index + 1, turn: Option.some(1), kind: next.kind, at: 0, data: json,
    }))])),
  )
  const held = yield* Ref.make<ReadonlyArray<TurnDraft>>([])
  const writer: TurnWriter = {
    admitted: { session: { id: session, owner: "conformance" }, turn: 1, runId: RUN, key: RUN, origin: "user", userMessage, command: {}, claimed: [], meta: {} },
    started,
    history: () => Effect.succeed([]),
    snapshot: (kinds, after) => Ref.get(stored).pipe(Effect.map((events) => events.filter((event) =>
      (after === undefined || event.seq > after) && (kinds.length === 0 || kinds.includes(event.kind))))),
    steers: Effect.succeed([]),
    take: () => Effect.succeed(false),
    append,
    write: (op) => op,
    transact: (decide) => decide([]).pipe(Effect.flatMap((decision) => append(decision.drafts).pipe(Effect.as({ result: decision.result, events: [] })))),
    flush: Ref.get(stored).pipe(Effect.flatMap((events) => Ref.set(flushed, events))),
    closing: (drafts) => Ref.set(held, drafts),
    end: () => Ref.getAndSet(held, []).pipe(Effect.flatMap(append), Effect.as({ pending: 0 })),
    closed: Effect.never,
  }
  return { writer, stored: Ref.get(stored), flushed: Ref.get(flushed) }
})

/** How a call ended, as the model would read it. */
interface CallResult {
  readonly isFailure: boolean
  readonly result: unknown
  readonly encoded: unknown
}

/** One turn over the registry, with its tools open. */
interface KitTurn {
  /** The registry's catalog. */
  readonly catalog: CapabilityCatalog
  readonly tools: RunTools
  /** Call a tool through the open toolkit's handlers at `step`, as the loop (or a host) does. */
  readonly call: (name: string, params: unknown, step?: number, toolCallId?: string, ordinal?: number) => Effect.Effect<CallResult, unknown>
  /** Another open of this same registry, proving per-tool permits are outside open's turn-local state. */
  readonly reopenCall: (name: string, params: unknown) => Effect.Effect<CallResult, unknown>
  /** The `tool.*` and `skills.activated` events published so far, in order. */
  readonly published: Effect.Effect<ReadonlyArray<TurnEvent>>
  /** What the turn stored so far. */
  readonly stored: Effect.Effect<ReadonlyArray<SessionLogEvent>>
  /** Rows already acknowledged by flush, without causing a fresh flush. */
  readonly durable: Effect.Effect<ReadonlyArray<SessionLogEvent>>
  /** The tools whose handlers ran, in order. */
  readonly ran: Effect.Effect<ReadonlyArray<string>>
}

interface TurnSetup {
  readonly maxCallsPerRun?: number
  readonly readConcurrency?: number
  readonly toolPolicy?: ToolRegistryLimits["toolPolicy"]
  readonly execution?: (tool: string) => Effect.Effect<void>
  readonly policy?: Context.Service.Shape<typeof ActionPolicy>
  readonly interceptor?: Context.Service.Shape<typeof ToolInterceptor>
  readonly auditFailure?: TurnError
  readonly grants?: ReadonlyArray<string>
  /** Record `kit_vault` as activated by an earlier turn, as a turn whose grants have since changed finds it. */
  readonly vaultActive?: boolean
  /** Open the tools without the `SessionEnvironment` that `kit_where` declares (they open with one by default). */
  readonly withoutEnvironment?: boolean
}

const messageOf = (result: unknown): string =>
  typeof result === "object" && result !== null && "message" in result && typeof result.message === "string" ? result.message : "none"

/** The name a failed call's result carries (`Failure.error`), as the kit reports it. */
const errorOf = (result: unknown): string =>
  typeof result === "object" && result !== null && "error" in result && typeof result.error === "string" ? result.error : "none"

/** Whether a failure's name is one the model reads: PascalCase (`ToolInactive`), never a host's code (`skills.unknown`). */
const isModelName = (name: string): boolean => /^[A-Z][A-Za-z0-9]*$/.test(name)

/** A failure's framework code, as the kit reports it. */
const codeOf = (error: unknown): string => Option.getOrElse(harnessCodeOf(error), () => "none")

/** The tool the model loads skills with. */
const LOAD_SKILL = "load_skill"

/** The tools a stored `memory.skills` record activates. */
const toolsOf = (data: unknown): ReadonlyArray<string> =>
  typeof data === "object" && data !== null && "body" in data && typeof data.body === "object" && data.body !== null
    && "tools" in data.body && Array.isArray(data.body.tools) ? data.body.tools.filter((tool): tool is string => typeof tool === "string") : []

/**
 * The ToolRegistry contract, as checks: the catalog and the run's tools
 * hold every tool and skill the capabilities define; always-on skills are
 * active once the matcher's choice is applied, other skills only once
 * activated, an unknown skill is refused (`skills.unknown`), a skill whose
 * permission is not granted is not activated, and the active set only grows,
 * publishing `skills.activated` for what is new; `load_skill` refuses an
 * unknown skill and an ungranted one as the call's result, under a
 * PascalCase name and never the host's code; `load_skill` calls running
 * at once (tool concurrency above 1) leave every loaded tool active and
 * listed, each published and recorded once; a handled call publishes
 * `tool.started`, its handler's `tool.progress` and `tool.completed` under
 * one invocation id (`<runId>:call:<n>`), and the handler sees that call
 * as `CurrentToolInvocation` and the services where the tools were opened,
 * the ones it declares (`RegisteredTool.requires`) included. The provider's
 * pairing key reaches the invocation, every lifecycle event and its journal
 * record as `toolCallId` (absent on direct calls without one). A run lacking
 * a service a tool declares fails to open its tools with
 * `requires.missing`, naming the tool and the service; and a call refused
 * before its handler runs (`inactive`, `forbidden`, `denied`, `call-limit`,
 * `tool-call-limit`) takes its invocation id first, publishes one
 * `tool.refused` with its input and no `tool.started`, never runs the
 * handler, and fails with the refusal's message as its result, under a
 * PascalCase name (`Failure.error`).
 * The registry publishes these events on the run's bus (`RunContext.events`)
 * only, and never writes the journal itself: the turn journals them (the sdk's
 * `TurnLive` keeps `tool.progress` out and stores a `tool.refused` without
 * its input). The kit reads the journal to catch a registry that writes it
 * directly; what the turn does with the events is `TurnLive`'s, not the
 * registry's.
 *
 * `make` builds a registry over the kit's capabilities for each check, with
 * at most `maxCallsPerRun` calls per turn and no permissions granted unless
 * the turn's `PermissionGrants` say so. The kit runs each turn over the sdk's
 * `TurnLive` with a writer that keeps the turn's events in memory, opens
 * the tools with a `SessionEnvironment` (which one of its tools declares)
 * and calls them with another, as a step would.
 */
export const toolRegistryConformance = (
  make: (capabilities: ReadonlyArray<Capability>, limits: ToolRegistryLimits) => Effect.Effect<Registry, unknown, Scope.Scope>,
): ReadonlyArray<ConformanceCheck> => {
  const inTurn = (setup: TurnSetup, body: (turn: KitTurn) => Effect.Effect<void, unknown>) => Effect.scoped(Effect.gen(function* () {
    const ran = yield* Ref.make<ReadonlyArray<string>>([])
    const registry = yield* make([capabilityOf(ran)], { maxCallsPerRun: setup.maxCallsPerRun ?? 32, ...(setup.readConcurrency === undefined ? {} : { readConcurrency: setup.readConcurrency }), ...(setup.toolPolicy === undefined ? {} : { toolPolicy: setup.toolPolicy }) })
    const recorded = yield* memoryWriter
    const writer: TurnWriter = setup.auditFailure === undefined ? recorded.writer : {
      ...recorded.writer,
      flush: recorded.stored.pipe(Effect.flatMap((events) => events.some((event) => event.kind === "tool.intercepted")
        ? Effect.fail(setup.auditFailure!) : recorded.writer.flush)),
    }
    const services = Layer.merge(
      Layer.succeed(ConversationMemory, ConversationMemory.of({ strategy: policy.strategy, open: ({ runId, log }) => openLogSession(log, policy, { runId }) })),
      Layer.succeed(ToolRegistry, registry),
    )
    return yield* Effect.gen(function* () {
      const run = yield* RunContext
      const published = yield* Ref.make<ReadonlyArray<TurnEvent>>([])
      yield* run.events.subscribe(
        (event) => event._tag.startsWith("tool.") || event._tag === "skills.activated" ? Option.some(event) : Option.none(),
        (event) => Ref.update(published, (all) => [...all, event]),
      )
      const memory = yield* TurnMemory
      yield* memory.persistMessage
      if (setup.vaultActive === true) yield* memory.session.record([{ _tag: "ToolsActivated", skills: ["kit.vault"], tools: [Vault.name], source: "host", decision: Option.none() }], 0)
      const opening = (yield* TurnToolbox).open.pipe(
        Effect.provideService(DurableStarted, recorded.flushed.pipe(Effect.map((events) => events.some((event) => event.kind === "tool.started" && event.data.tool === Durability.name)))),
        Effect.provideService(Opener, "the opener's"),
        Effect.provideService(ExecutionProbe, setup.execution ?? (() => Effect.void)),
        (open) => setup.withoutEnvironment === true ? open.pipe(Effect.updateContext((context: Context.Context<never>) => Context.omit(SessionEnvironment)(context)))
          : open.pipe(Effect.provideService(SessionEnvironment, { workspace: "the opener's" })),
        (open) => Option.match(Option.fromNullishOr(setup.policy), { onNone: () => open, onSome: (denying) => open.pipe(Effect.provideService(ActionPolicy, denying)) }),
        (open) => Option.match(Option.fromNullishOr(setup.interceptor), { onNone: () => open, onSome: (interceptor) => open.pipe(Effect.provideService(ToolInterceptor, interceptor)) }),
        (open) => Option.match(Option.fromNullishOr(setup.grants), {
          onNone: () => open,
          onSome: (grants) => open.pipe(Effect.provideService(PermissionGrants, PermissionGrants.of({ grants: Effect.succeed(new Set(grants)) }))),
        }),
      )
      const tools = yield* opening
      yield* tools.select(run.userMessage)
      const callWith = (selected: RunTools, name: string, params: unknown, step = 1, toolCallId?: string, ordinal = 0): Effect.Effect<CallResult, unknown> => (Effect.gen(function* () {
        const kit = yield* selected.toolkit.pipe(Effect.provide(selected.handlers))
        const results = yield* Stream.runCollect(yield* kit.handle(name, params, toolCallId))
        const last = results.at(-1)
        return { isFailure: last?.isFailure ?? true, result: last?.result, encoded: last?.encodedResult }
      }) as Effect.Effect<CallResult, unknown>).pipe(
        Effect.provideService(CurrentAgentStep, Option.some(step)),
        Effect.provideService(CurrentAgentRun, Option.some({ id: RUN, turn: 1, ordinal: RunOrdinal.make(ordinal) })),
        Effect.provideService(Opener, "the caller's"),
        Effect.provideService(SessionEnvironment, { workspace: "the caller's" }),
      )
      const call = (name: string, params: unknown, step?: number, toolCallId?: string, ordinal?: number) => callWith(tools, name, params, step, toolCallId, ordinal)
      const reopened = yield* registry.open(memory.session).pipe(
        Effect.provideService(SessionEnvironment, { workspace: "the opener's" }),
        Effect.provideService(ExecutionProbe, setup.execution ?? (() => Effect.void)),
      )
      const reopenCall = (name: string, params: unknown) => reopened.select(run.userMessage).pipe(Effect.andThen(callWith(reopened, name, params)))
      return yield* body({
        catalog: registry.catalog,
        tools,
        call,
        reopenCall,
        published: run.flush.pipe(Effect.orDie, Effect.andThen(Ref.get(published))),
        stored: run.flush.pipe(Effect.orDie, Effect.andThen(recorded.stored)),
        durable: recorded.flushed,
        ran: Ref.get(ran),
      })
    }).pipe(Effect.provide(TurnLive({ turn: writer })), Effect.provide(services))
  }))
  const tags = (events: ReadonlyArray<TurnEvent>) => events.map((event) => event._tag).join()
  const idOf = (event: TurnEvent): string => "invocationId" in event ? event.invocationId : ""
  const allow = Effect.succeed<BeforeToolDecision>({ _tag: "Allow" })
  const keep = Effect.succeed<AfterToolDecision>({ _tag: "Keep" })
  const tick = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { concurrency: 1, discard: true })
  const interceptCheck = (name: string, id: string, body: () => Effect.Effect<void, unknown>) =>
    check(name, id, () => body().pipe(Effect.catchDefect(() => fail(id, "the interception path failed before fulfilling its contract")), Effect.timeout("3 seconds")))
  const originalFailure = (exit: Exit.Exit<unknown, unknown>, original: unknown): boolean => Exit.isFailure(exit)
    && exit.cause.reasons.some((reason) => Cause.isFailReason(reason) ? reason.error === original : Cause.isDieReason(reason) && reason.defect === original)
  const failureHasCode = (exit: Exit.Exit<unknown, unknown>, code: string): boolean => Exit.isFailure(exit)
    && exit.cause.reasons.some((reason) => codeOf(Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : undefined) === code)

  /** One refusal: the calls made, which of them is refused (the earlier ones run) and how the turn is set up. */
  const refusal = (reason: ToolRefusalReason, id: string, calls: ReadonlyArray<readonly [string, unknown]>, setup: TurnSetup = {}): ConformanceCheck =>
    check(`a call refused as ${reason} takes its invocation id first, publishes one tool.refused and no tool.started on the run's bus only, and never runs the handler`, id, () =>
      inTurn(setup, (turn) => Effect.gen(function* () {
        const refusedAt = calls.length - 1
        const [tool, input] = calls[refusedAt]!
        const results = yield* Effect.forEach(calls, ([name, params]) => turn.call(name, params), { concurrency: 1 })
        const events = yield* turn.published
        const refused = events.flatMap((event) => event._tag === "tool.refused" ? [event] : [])
        yield* expect(id, refused.length === 1, `the calls published ${refused.length} tool.refused`)
        const event = refused[0]!
        yield* expect(id, event.reason === reason && event.tool === tool && event.step === 1 && JSON.stringify(event.input) === JSON.stringify(input),
          `the refusal was published as ${event.reason} of ${event.tool} at step ${event.step} with input ${JSON.stringify(event.input)}`)
        yield* expect(id, event.invocationId === `${RUN}:call:${refusedAt}`, `the refused call's id is ${event.invocationId}, not ${RUN}:call:${refusedAt} (ids are minted before the checks)`)
        const outcome = results[refusedAt]!
        yield* expect(id, outcome.isFailure && messageOf(outcome.result) === event.message && event.message.length > 0,
          `the refused call returned ${JSON.stringify(outcome.result)} (failure: ${outcome.isFailure}), not the refusal's message "${event.message}"`)
        yield* expect(id, isModelName(errorOf(outcome.result)), `the refused call failed as ${errorOf(outcome.result)}, not under a PascalCase name the model reads`)
        const others = events.filter((other) => other._tag !== "tool.refused" && idOf(other) === event.invocationId)
        yield* expect(id, others.length === 0, `the refused call also published ${tags(others)}`)
        const ran = yield* turn.ran
        yield* expect(id, ran.length === refusedAt, `the handlers ran for ${ran.join() || "no call"}; only the ${refusedAt} calls before the refused one should have`)
        const stored = (yield* turn.stored).filter((record) => record.kind === "tool.refused")
        yield* expect(id, stored.length === 1 && stored[0]!.data.invocationId === event.invocationId && !("input" in stored[0]!.data),
          `the turn stored ${stored.length} tool.refused${stored.length > 0 && "input" in stored[0]!.data ? ", with the call's input" : ""} (a registry publishes on the run's bus and never writes the journal itself)`)
      })))

  return [
    interceptCheck("absence keeps the original handler lifecycle and encoded answer", "interceptor-absence", () => inTurn({}, (turn) => Effect.gen(function* () {
      const outcome = yield* turn.call(Where.name, {})
      const events = yield* turn.published
      yield* expect("interceptor-absence", outcome.result === "the opener's" && outcome.encoded === "the opener's"
        && !events.some((event) => event._tag === "tool.intercepted")
        && events.filter((event) => event._tag === "tool.started" || event._tag === "tool.completed").length === 2,
      "absence changed the result or introduced interception facts")
    }))),
    interceptCheck("ActionPolicy precedes both hook phases and denied original calls skip them", "interceptor-order", () => Effect.gen(function* () {
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      const decisions = yield* Ref.make(0)
      yield* inTurn({
        policy: { authorize: () => Ref.updateAndGet(decisions, (n) => n + 1).pipe(Effect.flatMap((n) => Ref.update(order, (all) => [...all, "policy"]).pipe(
          Effect.andThen(n === 1 ? Effect.fail(new HarnessError({ code: "conformance.denied", message: "closed" })) : Effect.void)))) },
        interceptor: { before: () => Ref.update(order, (all) => [...all, "before"]).pipe(Effect.andThen(allow)), after: () => Ref.update(order, (all) => [...all, "after"]).pipe(Effect.andThen(keep)) },
        execution: () => Ref.update(order, (all) => [...all, "handler"]),
      }, (turn) => Effect.gen(function* () {
        yield* turn.call(Where.name, {})
        yield* expect("interceptor-order", (yield* Ref.get(order)).join() === "policy", "an original policy refusal invoked a hook")
        yield* turn.call(Where.name, {})
        yield* expect("interceptor-order", (yield* Ref.get(order)).join() === "policy,policy,before,handler,after", "the fixed policy/before/handler/after order changed")
        yield* expect("interceptor-order", (yield* turn.published).filter((event) => event._tag === "tool.intercepted").length === 2, "accepted Allow/Keep phases were not audited")
      }))
    })),
    interceptCheck("Deny returns its refusal without consuming caps or fabricating a handler", "interceptor-deny", () => Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const after = yield* Ref.make(0)
      yield* inTurn({ maxCallsPerRun: 1, interceptor: {
        before: () => Ref.updateAndGet(calls, (n) => n + 1).pipe(Effect.map((n): BeforeToolDecision => n === 1 ? { _tag: "Deny", failure: { error: "HostDenied", message: "Use another action." } } : { _tag: "Allow" })),
        after: () => Ref.update(after, (n) => n + 1).pipe(Effect.andThen(keep)),
      } }, (turn) => Effect.gen(function* () {
        const denied = yield* turn.call(Where.name, {})
        yield* expect("interceptor-deny", denied.isFailure && errorOf(denied.result) === "HostDenied" && (yield* turn.ran).length === 0, "Deny ran a handler or lost its failure")
        const allowed = yield* turn.call(Where.name, {})
        const limited = yield* turn.call(Where.name, {})
        yield* expect("interceptor-deny", !allowed.isFailure && errorOf(limited.result) === "CallLimit" && (yield* Ref.get(after)) === 1 && (yield* turn.ran).length === 1, "Deny consumed a cap or invoked after")
        yield* expect("interceptor-deny", (yield* turn.published).some((event) => event._tag === "tool.refused" && event.reason === "intercepted"), "Deny lost its interception refusal")
      }))
    })),
    interceptCheck("Rewrite validates encoded input and reauthorizes decoded effective parameters", "interceptor-rewrite", () => Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<number>>([])
      const nOf = (input: unknown) => Option.match(Schema.decodeUnknownOption(Ping.parametersSchema)(input), { onNone: () => -1, onSome: (value) => value.n })
      yield* inTurn({ policy: { authorize: (_tool, input) => Ref.update(seen, (all) => [...all, nOf(input)]) }, interceptor: {
        before: () => Effect.succeed({ _tag: "Rewrite", input: { n: 7 } }), after: () => keep,
      } }, (turn) => Effect.gen(function* () {
        const result = yield* turn.call(Ping.name, { n: 1 })
        yield* expect("interceptor-rewrite", result.result === "pong 7" && (yield* Ref.get(seen)).join() === "1,7", "Rewrite did not reauthorize the actual effective input")
      }))
      yield* inTurn({ policy: { authorize: (_tool, input) => nOf(input) === 99 ? Effect.fail(new HarnessError({ code: "conformance.denied", message: "effective input denied" })) : Effect.void }, interceptor: {
        before: () => Effect.succeed({ _tag: "Rewrite", input: { n: 99 } }), after: () => keep,
      } }, (turn) => Effect.gen(function* () {
        const denied = yield* turn.call(Ping.name, { n: 2 })
        yield* expect("interceptor-rewrite", denied.isFailure && errorOf(denied.result) === "PolicyDenied" && (yield* turn.ran).length === 0, "rewritten input bypassed effective authorization")
      }))
    })),
    interceptCheck("Respond consumes admission but skips handler gates, lifecycle and after", "interceptor-respond", () => Effect.gen(function* () {
      const after = yield* Ref.make(0)
      yield* inTurn({ maxCallsPerRun: 1, interceptor: {
        before: () => Effect.succeed({ _tag: "Respond", outcome: { _tag: "Success", encoded: "synthetic" } }),
        after: () => Ref.update(after, (n) => n + 1).pipe(Effect.andThen(keep)),
      } }, (turn) => Effect.gen(function* () {
        const first = yield* turn.call(Where.name, {})
        const limited = yield* turn.call(Where.name, {})
        const events = yield* turn.published
        yield* expect("interceptor-respond", first.result === "synthetic" && first.encoded === "synthetic" && errorOf(limited.result) === "CallLimit"
          && (yield* turn.ran).length === 0 && (yield* Ref.get(after)) === 0 && !events.some((event) => event._tag === "tool.started" || event._tag === "tool.completed"),
        "Respond ran a handler, fabricated lifecycle or escaped admission")
      }))
    })),
    interceptCheck("Replace changes the effective answer while onTool keeps the actual handler evidence", "interceptor-after", () => inTurn({ interceptor: {
      before: () => allow, after: () => Effect.succeed({ _tag: "Replace", outcome: { _tag: "Failure", encoded: { error: "HostReplaced", message: "The replacement is final." } } }),
    } }, (turn) => Effect.gen(function* () {
      const result = yield* turn.call(Where.name, {})
      const completed = (yield* turn.published).filter((event) => event._tag === "tool.completed")
      yield* expect("interceptor-after", result.isFailure && errorOf(result.result) === "HostReplaced" && completed.length === 1
        && completed[0]?.ok === true && completed[0].result === "the opener's" && (yield* turn.ran).length === 1,
      "Replace changed actual handler evidence or failed to replace the final answer")
    }))),
    interceptCheck("before audit is acknowledged before the handler and audit failure runs no handler", "interceptor-durable", () => Effect.gen(function* () {
      const read = yield* Ref.make<Effect.Effect<ReadonlyArray<SessionLogEvent>>>(Effect.succeed([]))
      const observed = yield* Ref.make(false)
      yield* inTurn({ interceptor: { before: () => allow, after: () => keep }, execution: () => Ref.get(read).pipe(Effect.flatten,
        Effect.flatMap((events) => Ref.set(observed, events.some((event) => event.kind === "tool.intercepted")))) }, (turn) => Effect.gen(function* () {
          yield* Ref.set(read, turn.durable)
          yield* turn.call(Where.name, {})
          yield* expect("interceptor-durable", yield* Ref.get(observed), "handler ran before its audit ACK")
        }))
      const original = new SessionLogError({ code: "store.io", message: "audit acknowledgment failed" })
      yield* inTurn({ auditFailure: original, interceptor: { before: () => allow, after: () => keep } }, (turn) => Effect.gen(function* () {
        const exit = yield* Effect.exit(turn.call(Where.name, {}))
        yield* expect("interceptor-durable", originalFailure(exit, original) && (yield* turn.ran).length === 0, "an audit failure was relabelled or ran a handler")
      }))
    })),
    interceptCheck("invalid decisions and hook defects are hard failures, original turn errors and interruption survive", "interceptor-errors", () => Effect.gen(function* () {
      const original = new SessionLogError({ code: "store.io", message: "original hook failure" })
      yield* inTurn({ interceptor: { before: () => Effect.fail(original), after: () => keep } }, (turn) => Effect.gen(function* () {
        yield* expect("interceptor-errors", originalFailure(yield* Effect.exit(turn.call(Where.name, {})), original) && (yield* turn.ran).length === 0, "a typed hook failure lost its identity")
      }))
      yield* inTurn({ interceptor: { before: () => Effect.die(new Error("foreign hook defect")), after: () => keep } }, (turn) => Effect.gen(function* () {
        yield* expect("interceptor-errors", failureHasCode(yield* Effect.exit(turn.call(Where.name, {})), "tool.intercept") && (yield* turn.ran).length === 0, "a hook defect became a model result or ran a handler")
      }))
      yield* inTurn({ interceptor: { before: () => Effect.succeed({ _tag: "Rewrite", input: "invalid parameters" }), after: () => keep } }, (turn) => Effect.gen(function* () {
        yield* expect("interceptor-errors", failureHasCode(yield* Effect.exit(turn.call(Ping.name, { n: 1 })), "tool.intercept") && (yield* turn.ran).length === 0, "invalid Rewrite was treated as a model mistake")
      }))
      const calls = yield* Ref.make(0), release = yield* Deferred.make<void>()
      yield* inTurn({ interceptor: { before: () => Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(allow)), after: () => keep } }, (turn) => Effect.gen(function* () {
        const work = yield* turn.call(Where.name, {}).pipe(Effect.forkChild)
        yield* tick
        const stopping = yield* Fiber.interrupt(work).pipe(Effect.forkChild)
        yield* tick
        const stopped = stopping.pollUnsafe() !== undefined
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(stopping)
        const exit = yield* Fiber.await(work)
        yield* expect("interceptor-errors", (yield* Ref.get(calls)) === 1 && stopped && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) && (yield* turn.ran).length === 0, "held hook was masked or interruption relabelled")
      }))
    })),
    interceptCheck("hook evidence is encoded, immutable and bound to actual caller run and captured services", "interceptor-scope", () => Effect.gen(function* () {
      const observations = yield* Ref.make<ReadonlyArray<boolean>>([])
      const observe = (input: { readonly input: unknown; readonly run: Option.Option<{ readonly ordinal: number }>; readonly step: number }) => Effect.gen(function* () {
        const run = yield* CurrentAgentRun, step = yield* CurrentAgentStep, opener = yield* Opener
        yield* Ref.update(observations, (all) => [...all, Object.isFrozen(input.input) && JSON.stringify(input.input) === '{"n":3}'
          && Option.isSome(input.run) && input.run.value.ordinal === 4 && input.step === 9 && Option.isSome(run) && run.value.ordinal === 4 && Option.contains(step, 9) && opener === "the opener's"])
      })
      yield* inTurn({ interceptor: { before: (input) => observe(input).pipe(Effect.andThen(allow)), after: (input) => observe(input).pipe(Effect.andThen(keep)) } }, (turn) => Effect.gen(function* () {
        const outcome = yield* turn.call(Ping.name, { n: 3 }, 9, "interceptor-scope", 4)
        yield* expect("interceptor-scope", outcome.result === "pong 3" && (yield* Ref.get(observations)).join() === "true,true", "callbacks saw mutable evidence or the wrong run/services")
      }))
    })),
    interceptCheck("replacement preserves actual breaker failures and Respond cannot revive a tripped tool", "interceptor-policy", () => Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      yield* inTurn({ toolPolicy: { [Flaky.name]: { breakAfter: 1, breakOn: "failures" } }, interceptor: {
        before: () => Ref.updateAndGet(calls, (n) => n + 1).pipe(Effect.map((n): BeforeToolDecision => n === 1 ? { _tag: "Allow" } : { _tag: "Respond", outcome: { _tag: "Success", encoded: "revived" } })),
        after: () => Effect.succeed({ _tag: "Replace", outcome: { _tag: "Success", encoded: "masked failure" } }),
      } }, (turn) => Effect.gen(function* () {
        const first = yield* turn.call(Flaky.name, { outcome: "failure" })
        const tripped = yield* turn.call(Flaky.name, { outcome: "success" })
        yield* expect("interceptor-policy", first.result === "masked failure" && !first.isFailure && errorOf(tripped.result) === "ToolTripped" && (yield* turn.ran).length === 1,
          "replacement reset actual failure accounting or Respond escaped a tripped breaker")
      }))
    })),
    check("nested synchronous toolkit calls preserve a queued writer's priority", "nested-writer-priority", () => Effect.gen(function* () {
      const count = yield* Ref.make(0)
      const both = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const held = yield* Ref.make<Option.Option<KitTurn>>(Option.none())
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      const nested = yield* Ref.make("none")
      yield* inTurn({ readConcurrency: 2, execution: (tool) => tool === Flaky.name ? Ref.update(order, (all) => [...all, "writer"]) : Effect.gen(function* () {
        const position = yield* Ref.updateAndGet(count, (n) => n + 1)
        if (position <= 2) {
          if (position === 2) yield* Deferred.succeed(both, undefined)
          return yield* Deferred.await(release)
        }
        yield* Ref.update(order, (all) => [...all, position === 3 ? "reader" : "nested"])
        if (position === 3) {
          const outcome = yield* Option.getOrThrow(yield* Ref.get(held)).call(Where.name, {}).pipe(
            Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync")), Effect.orDie,
          )
          yield* Ref.set(nested, errorOf(outcome.result))
        }
      }) }, (turn) => Effect.gen(function* () {
        yield* Ref.set(held, Option.some(turn))
        const holders = yield* Effect.forEach([0, 1], () => turn.call(Where.name, {}), { concurrency: 2 }).pipe(Effect.forkChild)
        yield* Deferred.await(both)
        const reader = yield* turn.call(Where.name, {}).pipe(Effect.forkChild)
        yield* Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, { concurrency: 1 })
        const writer = yield* turn.call(Flaky.name, { outcome: "success" }).pipe(Effect.forkChild)
        yield* Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, { concurrency: 1 })
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holders)
        yield* Fiber.join(reader)
        yield* Fiber.join(writer)
        yield* expect("nested-writer-priority", (yield* Ref.get(order)).join() === "reader,writer" && (yield* Ref.get(nested)) === "ToolConcurrency", "a synchronous nested call overtook the queued writer")
      }))
    }).pipe(Effect.timeout("2 seconds"))),
    check("a turn's writers exclude readers and cannot be overtaken by later readers", "read-write-lanes", () => Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      yield* inTurn({ execution: (tool) => Ref.updateAndGet(order, (all) => [...all, tool]).pipe(Effect.flatMap((all) => all.length === 1
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)) }, (turn) => Effect.gen(function* () {
        const first = yield* turn.call(Where.name, {}).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const writer = yield* turn.call(Flaky.name, { outcome: "success" }).pipe(Effect.forkChild)
        yield* Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, { concurrency: 1 })
        const last = yield* turn.call(Where.name, {}).pipe(Effect.forkChild)
        yield* Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, { concurrency: 1 })
        yield* expect("read-write-lanes", (yield* Ref.get(order)).join() === Where.name, "a writer overlapped a reader or a later reader overtook it")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(writer)
        yield* Fiber.join(last)
        yield* expect("read-write-lanes", (yield* Ref.get(order)).join() === [Where.name, Flaky.name, Where.name].join(), "a waiting writer was starved by a later reader")
      }))
    }).pipe(Effect.timeout("2 seconds"))),
    check("per-tool concurrency permits are shared across turn opens and are released after interrupted handlers", "policy-concurrency", () => Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const active = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      const waiting = yield* Ref.make(false)
      yield* inTurn({ toolPolicy: { [Where.name]: { concurrency: 1 } }, execution: () => Ref.updateAndGet(active, (n) => n + 1).pipe(
        Effect.tap((n) => Ref.update(peak, (value) => Math.max(value, n))),
        Effect.flatMap((n) => n === 1 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) : Effect.void),
        Effect.ensuring(Ref.update(active, (n) => n - 1)),
      ) }, (turn) => Effect.gen(function* () {
        const first = yield* turn.call(Where.name, {}).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const second = yield* turn.reopenCall(Where.name, {}).pipe(Effect.ensuring(Ref.set(waiting, true)), Effect.forkChild)
        yield* Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, { concurrency: 1 })
        yield* expect("policy-concurrency", (yield* Ref.get(peak)) === 1 && !(yield* Ref.get(waiting)), "a second open escaped the agent-wide per-tool permit")
        const stopping = yield* Fiber.interrupt(second).pipe(Effect.forkChild)
        yield* Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, { concurrency: 1 })
        const cancelledBeforeRelease = yield* Ref.get(waiting)
        yield* Fiber.interrupt(first)
        yield* Fiber.join(stopping)
        yield* expect("policy-concurrency", cancelledBeforeRelease, "a queued permit wait could not be interrupted while its holder remained active")
        const fresh = yield* turn.reopenCall(Where.name, {}).pipe(Effect.forkChild)
        // A fresh handler may block too: interrupting it proves the permit transferred, not a leaked lock.
        yield* Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, { concurrency: 1 })
        yield* expect("policy-concurrency", (yield* turn.ran).length === 2, "interruption leaked the first call's permit")
        yield* Fiber.interrupt(fresh)
      }))
    }).pipe(Effect.timeout("2 seconds"))),
    check("host per-tool call limits are atomic and reset by exact loop run while author limits remain per turn", "policy-run-limit", () => inTurn({ toolPolicy: { [Where.name]: { maxCallsPerRun: 1 }, [Ping.name]: { maxCallsPerRun: 100 } } }, (turn) => Effect.gen(function* () {
      const results = yield* Effect.forEach([0, 0], (run) => turn.call(Where.name, {}, 1, undefined, run), { concurrency: 2 })
      yield* expect("policy-run-limit", results.filter((result) => !result.isFailure).length === 1 && results.some((result) => errorOf(result.result) === "ToolCallLimit"), "simultaneous admissions did not share the run's one-call budget")
      yield* expect("policy-run-limit", !(yield* turn.call(Where.name, {}, 1, undefined, 1)).isFailure, "a fresh run did not reset its host call budget")
      yield* turn.call(Ping.name, { n: 1 }, 1, undefined, 0)
      yield* turn.call(Ping.name, { n: 2 }, 1, undefined, 1)
      yield* expect("policy-run-limit", errorOf((yield* turn.call(Ping.name, { n: 3 }, 1, undefined, 2)).result) === "ToolCallLimit", "host policy widened the author's per-turn budget")
    }))),
    check("the default breaker counts consecutive handler defects per run and tool, with successful calls resetting it", "policy-breaker", () => inTurn({ toolPolicy: { [Flaky.name]: { breakAfter: 2 } } }, (turn) => Effect.gen(function* () {
      yield* turn.call(Flaky.name, { outcome: "defect" })
      yield* turn.call(Flaky.name, { outcome: "success" })
      yield* turn.call(Flaky.name, { outcome: "defect" })
      yield* turn.call(Flaky.name, { outcome: "failure" })
      yield* expect("policy-breaker", !(yield* turn.call(Flaky.name, { outcome: "success" })).isFailure, "a typed failure tripped the defects-only breaker, or success did not reset it")
      yield* turn.call(Flaky.name, { outcome: "defect" })
      yield* turn.call(Flaky.name, { outcome: "defect" })
      const before = (yield* turn.ran).length
      const refused = yield* turn.call(Flaky.name, { outcome: "success" }, 1, "tripped-call")
      const events = yield* turn.published
      yield* expect("policy-breaker", errorOf(refused.result) === "ToolTripped" && (yield* turn.ran).length === before, "a tripped tool ran its handler")
      yield* expect("policy-breaker", events.some((event) => event._tag === "tool.refused" && event.reason === "tripped" && event.toolCallId === "tripped-call"), "the tripped refusal lost its provider id or reason")
      yield* expect("policy-breaker", !(yield* turn.call(Where.name, {})).isFailure && !(yield* turn.call(Flaky.name, { outcome: "success" }, 1, undefined, 1)).isFailure, "a breaker escaped its tool or loop-run scope")
      yield* expect("policy-breaker", errorOf((yield* turn.call(Flaky.name, { outcome: "success" }, 1, undefined, 0)).result) === "ToolTripped", "a concurrent later run reset an earlier run's breaker")
    }))),
    check("breakOn failures counts typed handler failures as well as defects", "policy-failures", () => inTurn({ toolPolicy: { [Flaky.name]: { breakAfter: 1, breakOn: "failures" } } }, (turn) => Effect.gen(function* () {
      yield* turn.call(Flaky.name, { outcome: "failure" })
      yield* expect("policy-failures", errorOf((yield* turn.call(Flaky.name, { outcome: "success" })).result) === "ToolTripped", "a typed handler failure did not trip the configured breaker")
    }))),
    check("the catalog and a run's tools hold every tool and skill the capabilities define, with their permissions", "catalog", () => inTurn({}, (turn) => Effect.gen(function* () {
      const recipes = turn.catalog.recipes.map((recipe): string => recipe.id)
      const listed = turn.catalog.tools.map((tool): string => tool.id)
      yield* expect("catalog", SKILLS.every((skill) => recipes.includes(skill)) && TOOLS.every((tool) => listed.includes(tool)),
        `the catalog lists the skills ${recipes.join()} and the tools ${listed.join()}`)
      const vault = turn.catalog.tools.find((tool) => tool.id === Vault.name)
      yield* expect("catalog", vault?.permissions.join() === "kit.vault", `the catalog gives ${Vault.name} the permissions [${vault?.permissions.join() ?? "of no entry"}]`)
      const skills = turn.tools.skills.map((skill): string => skill.id)
      yield* expect("catalog", SKILLS.every((skill) => skills.includes(skill)), `the run's skills are ${skills.join()}`)
      const toolkit = Object.keys(turn.tools.toolkit.tools)
      yield* expect("catalog", TOOLS.every((tool) => toolkit.includes(tool)), `the run's toolkit holds ${toolkit.join()}`)
    }))),

    check("always-on skills are active, others only once activated; an unknown skill is refused and an ungranted one stays inactive; the active set only grows", "activation", () => inTurn({}, (turn) => Effect.gen(function* () {
      const active = yield* turn.tools.active
      yield* expect("activation", active.includes(Ping.name) && active.includes(Report.name) && !active.includes(Archive.name) && !active.includes(Vault.name),
        `with only the always-on skill applied, the active tools are ${active.join()}`)
      const returned = yield* turn.tools.activate(["kit.archiving"], "host")
      const grown = yield* turn.tools.active
      yield* expect("activation", returned.includes(Archive.name) && grown.includes(Archive.name) && active.every((tool) => grown.includes(tool)),
        `after activating kit.archiving the active tools are ${grown.join()} (activate returned ${returned.join()})`)
      yield* turn.tools.activate(["kit.archiving"], "host")
      const again = yield* turn.tools.active
      yield* expect("activation", again.join() === grown.join(), `activating kit.archiving again changed the active tools to ${again.join()}`)
      const activated = (yield* turn.published).flatMap((event) => event._tag === "skills.activated" ? [event] : [])
      yield* expect("activation", activated.filter((event) => event.skills.includes("kit.archiving")).length === 1
        && activated.some((event) => event.tools.includes(Archive.name)), `kit.archiving's activation published ${activated.length} skills.activated`)
      const unknown = yield* Effect.flip(turn.tools.activate(["kit.no-such-skill"], "host"))
      yield* expect("activation", failureCode(unknown) === "skills.unknown", `activating an unknown skill failed with ${failureCode(unknown)}`)
      yield* Effect.result(turn.tools.activate(["kit.vault"], "host"))
      const after = yield* turn.tools.active
      yield* expect("activation", !after.includes(Vault.name) && grown.every((tool) => after.includes(tool)), `after asking for a skill whose permission is not granted the active tools are ${after.join()}`)
    }))),

    check("load_skill refuses an unknown skill and an ungranted one as the call's result, under a PascalCase name and never the host's code, and activates neither", "load-refusal", () => inTurn({}, (turn) => Effect.gen(function* () {
      const refusals = yield* Effect.forEach([["kit.no-such-skill"], ["kit.vault"]], (skills) => turn.call(LOAD_SKILL, { skills }), { concurrency: 1 })
      yield* expect("load-refusal", refusals.every((refusal) => refusal.isFailure && isModelName(errorOf(refusal.result)) && !["", "none"].includes(messageOf(refusal.result))),
        `load_skill of an unknown and an ungranted skill returned ${JSON.stringify(refusals.map((refusal) => refusal.result))}, not failures under PascalCase names with a message`)
      const active = yield* turn.tools.active
      yield* expect("load-refusal", !active.includes(Vault.name), `after load_skill refused kit.vault the active tools are ${active.join()}`)
    }))),

    check("skills loaded by concurrent load_skill calls (tool concurrency above 1) all leave their tools active and listed, each activated and recorded once", "concurrent-load", () => inTurn({ grants: ["kit.vault"] }, (turn) => Effect.gen(function* () {
      const toolkit = Object.keys(turn.tools.toolkit.tools)
      yield* expect("concurrent-load", toolkit.includes(LOAD_SKILL), `the run's toolkit holds no ${LOAD_SKILL} (${toolkit.join()})`)
      // The same skill twice: the one that comes second finds it loaded, and adds nothing.
      const requests = [["kit.archiving"], ["kit.vault"], ["kit.archiving"]]
      const loads = yield* Effect.forEach(requests, (skills) => turn.call(LOAD_SKILL, { skills }), { concurrency: requests.length })
      yield* expect("concurrent-load", loads.every((load) => !load.isFailure), `the concurrent loads returned ${JSON.stringify(loads.map((load) => load.result))}`)
      const active = yield* turn.tools.active
      yield* expect("concurrent-load", active.includes(Archive.name) && active.includes(Vault.name),
        `after loading kit.archiving and kit.vault concurrently the active tools are ${active.join()}`)
      const used = yield* Effect.all([turn.call(Archive.name, { id: "r1" }), turn.call(Vault.name, { key: "k" })], { concurrency: 1 })
      yield* expect("concurrent-load", used.every((call) => !call.isFailure), `the loaded tools returned ${JSON.stringify(used.map((call) => call.result))}`)
      const loaded = [Archive.name, Vault.name]
      const once = (tools: ReadonlyArray<string>) => loaded.every((tool) => tools.filter((other) => other === tool).length === 1)
      const published = (yield* turn.published).flatMap((event) => event._tag === "skills.activated" ? event.tools : [])
      yield* expect("concurrent-load", once(published), `the loads published skills.activated for ${published.join()}, not each loaded tool once`)
      const recorded = (yield* turn.stored).flatMap((event) => event.kind === "memory.skills" ? toolsOf(event.data) : [])
      yield* expect("concurrent-load", once(recorded), `memory recorded the activations of ${recorded.join()}, not each loaded tool once`)
    }))),

    check("a handled call publishes tool.started, its progress and tool.completed under one invocation id, minted after a refused call's, which its handler sees, on the run's bus only", "invocation", () => inTurn({}, (turn) => Effect.gen(function* () {
      // A refused call first: it takes id 0, so the handled one is call 1.
      yield* turn.call(Archive.name, { id: "r0" })
      const outcome = yield* turn.call(Report.name, {}, 2)
      const id = `${RUN}:call:1`
      yield* expect("invocation", !outcome.isFailure && outcome.result === `${id}|${Report.name}|2|the opener's`,
        `the handler saw ${JSON.stringify(outcome.result)}, not its call ${id}|${Report.name}|2 and the services where the tools were opened`)
      const events = (yield* turn.published).filter((event) => event._tag.startsWith("tool."))
      yield* expect("invocation", tags(events) === "tool.refused,tool.started,tool.progress,tool.progress,tool.completed", `the two calls published ${tags(events)}`)
      const handled = events.slice(1)
      yield* expect("invocation", idOf(events[0]!) === `${RUN}:call:0` && handled.every((event) => idOf(event) === id && "tool" in event && event.tool === Report.name && "step" in event && event.step === 2),
        `the calls' events carry the ids ${events.map(idOf).join()}`)
      const completed = events.at(-1)
      yield* expect("invocation", completed?._tag === "tool.completed" && completed.ok, "the handled call did not complete ok")
      const stored = (yield* turn.stored).map((event) => event.kind).filter((kind) => kind.startsWith("tool."))
      yield* expect("invocation", stored.join() === "tool.refused,tool.started,tool.completed", `the turn stored ${stored.join()} (a registry publishes on the run's bus and never writes the journal itself)`)
      const next = yield* turn.call(Ping.name, { n: 1 })
      const started = (yield* turn.published).filter((event) => event._tag === "tool.started").map(idOf)
      yield* expect("invocation", !next.isFailure && started.join() === `${id},${RUN}:call:2`, `the next call took the id ${started.at(-1) ?? "none"}`)
    }))),

    check("the provider's call id reaches concurrent handlers, their lifecycle events and the journal, including refusals; a direct call has none", "provider-call-id", () => inTurn({}, (turn) => Effect.gen(function* () {
      const ids = ["provider:a", "provider:b"]
      const outcomes = yield* Effect.forEach(ids, (id) => turn.call(Report.name, {}, 3, id), { concurrency: 2 })
      yield* expect("provider-call-id", outcomes.every((outcome, at) => !outcome.isFailure && typeof outcome.result === "string" && outcome.result.endsWith(`|${ids[at]}`)),
        "a concurrent handler did not see its own provider call id")
      yield* turn.call(Vault.name, { key: "k" }, 3, "provider:refused")
      const events = (yield* turn.published).filter((event) => event._tag.startsWith("tool."))
      yield* expect("provider-call-id", ids.every((id) => {
        const own = events.filter((event) => "toolCallId" in event && event.toolCallId === id)
        return tags(own) === "tool.started,tool.progress,tool.progress,tool.completed"
          && own.every((event) => idOf(event) === idOf(own[0]!))
      }), "a handled call's lifecycle events lost or mixed provider call ids")
      const refused = events.at(-1)
      yield* expect("provider-call-id", refused?._tag === "tool.refused" && refused.toolCallId === "provider:refused", "a refusal lost the provider call id")
      const stored = (yield* turn.stored).filter((record) => record.kind.startsWith("tool."))
      yield* expect("provider-call-id", ids.every((id) => stored.filter((record) => record.data.toolCallId === id).map((record) => record.kind).join() === "tool.started,tool.completed")
        && stored.at(-1)?.data.toolCallId === "provider:refused", "the journal lost the calls' provider ids")
      const before = events.length
      yield* turn.call(Report.name, {})
      const direct = (yield* turn.published).filter((event) => event._tag.startsWith("tool.")).slice(before)
      yield* expect("provider-call-id", direct.length === 4 && direct.every((event) => !("toolCallId" in event)), "a direct call inherited another call's provider id")
    }))),

    check("a handler starts only after its tool.started record was flushed", "started-durable", () => inTurn({}, (turn) => Effect.gen(function* () {
      const outcome = yield* turn.call(Durability.name, {})
      yield* expect("started-durable", !outcome.isFailure && outcome.result === true, "the handler ran before its tool.started record was flushed")
    }))),

    check("a run lacking a service a tool declares fails to open its tools, with requires.missing naming the tool and the service", "requires-missing", () => Effect.gen(function* () {
      const failed = yield* inTurn({ withoutEnvironment: true }, () => Effect.void).pipe(Effect.match({ onFailure: Option.some, onSuccess: () => Option.none<unknown>() }))
      yield* Option.match(failed, {
        onNone: () => fail("requires-missing", `the tools opened in a run without ${SessionEnvironment.key}, which ${Where.name} declares`),
        onSome: (error) => expect("requires-missing", codeOf(error) === "requires.missing" && messageOf(error).includes(Where.name) && messageOf(error).includes(SessionEnvironment.key),
          `opening the tools without ${SessionEnvironment.key} failed with ${codeOf(error)} ("${messageOf(error)}"), not requires.missing naming ${Where.name} and the service`),
      })
    })),

    check("a handler sees the services it declares as they are where its run's tools were opened, not where it is called", "requires-opened", () => inTurn({}, (turn) => Effect.gen(function* () {
      const outcome = yield* turn.call(Where.name, {})
      yield* expect("requires-opened", !outcome.isFailure && outcome.result === "the opener's",
        `${Where.name} returned ${JSON.stringify(outcome.result)} (failure: ${outcome.isFailure}), not the workspace of where the tools were opened`)
    }))),

    check("the turn's PermissionGrants, read where the tools are opened, let a skill that needs them be activated and its tools run", "grants", () => inTurn({ grants: ["kit.vault"] }, (turn) => Effect.gen(function* () {
      yield* turn.tools.activate(["kit.vault"], "host")
      const active = yield* turn.tools.active
      yield* expect("grants", active.includes(Vault.name), `with kit.vault granted, activating its skill left the active tools ${active.join()}`)
      const outcome = yield* turn.call(Vault.name, { key: "k" })
      yield* expect("grants", !outcome.isFailure && outcome.result === "secret k", `the granted call returned ${JSON.stringify(outcome.result)}`)
    }))),

    refusal("inactive", "refused-inactive", [[Archive.name, { id: "r1" }]]),
    refusal("forbidden", "refused-forbidden", [[Vault.name, { key: "k" }]], { vaultActive: true }),
    refusal("denied", "refused-denied", [[Ping.name, { n: 1 }]], {
      policy: ActionPolicy.of({ authorize: (tool) => tool === Ping.name ? Effect.fail(new HarnessError({ code: "conformance.denied", message: "pings are closed today" })) : Effect.void }),
    }),
    refusal("call-limit", "refused-call-limit", [[Ping.name, { n: 1 }], [Ping.name, { n: 2 }]], { maxCallsPerRun: 1 }),
    refusal("tool-call-limit", "refused-tool-call-limit", [[Ping.name, { n: 1 }], [Ping.name, { n: 2 }], [Ping.name, { n: 3 }]]),
  ]
}
