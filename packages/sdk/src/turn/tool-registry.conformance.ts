import { Tool } from "effect/ai"
import { Array as Arr, Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
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
  harnessCodeOf,
  HarnessError,
  openLogSession,
  PermissionGrants,
  publishToolProgress,
  RunContext,
  RunId,
  SessionEnvironment,
  storedJson,
  ToolRegistry,
  TurnMemory,
  turnStartedDraft,
  TurnToolbox,
  UserMessage,
} from "@xandreed/core"
import type {
  Capability,
  CapabilityCatalog,
  MemoryPolicy,
  RunTools,
  SessionLogEvent,
  ToolRefusalReason,
  TurnDraft,
  TurnEvent,
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
}

/** The run the kit's turns are, as its invocation ids name it. */
const RUN = RunId.make("conformance-run")

/** A service of whoever opens the tools, which the handlers must see (and not the caller's). */
const Opener = Context.Reference<string>("efferent/conformance/ToolRegistryOpener", { defaultValue: () => "none" })

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
const TOOLS = [Ping.name, Report.name, Where.name, Vault.name, Archive.name]
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
      defineTool({ tool: Ping, handler: ({ n }) => note(Ping.name).pipe(Effect.as(`pong ${n}`)), annotations: { maxCallsPerRun: Option.some(2) } }),
      defineTool({
        tool: Report,
        handler: () => Effect.gen(function* () {
          yield* note(Report.name)
          const invocation = yield* Effect.service(CurrentToolInvocation)
          const opener = yield* Effect.service(Opener)
          yield* publishToolProgress("stdout", "working")
          yield* publishToolProgress("status", "half way")
          return `${Option.match(invocation, { onNone: () => "no invocation", onSome: (call) => `${call.invocationId}|${call.tool}|${call.step}` })}|${opener}`
        }),
      }),
      defineTool({
        tool: Where,
        requires: [SessionEnvironment],
        handler: () => note(Where.name).pipe(Effect.andThen(SessionEnvironment), Effect.map((environment) => environment.workspace)),
      }),
      defineTool({ tool: Vault, handler: ({ key }) => note(Vault.name).pipe(Effect.as(`secret ${key}`)), annotations: { permissions: ["kit.vault"] } }),
      defineTool({ tool: Archive, handler: ({ id }) => note(Archive.name).pipe(Effect.as(`archived ${id}`)) }),
    ],
    skills: [
      defineSkill({ id: "kit.basics", summary: "Ping, report and say where.", tools: [Ping.name, Report.name, Where.name], always: true }),
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
    append,
    write: (op) => op,
    transact: (decide) => decide([]).pipe(Effect.flatMap((decision) => append(decision.drafts).pipe(Effect.as({ result: decision.result, events: [] })))),
    flush: Effect.void,
    closing: (drafts) => Ref.set(held, drafts),
    end: () => Ref.getAndSet(held, []).pipe(Effect.flatMap(append), Effect.as({ pending: 0 })),
    closed: Effect.never,
  }
  return { writer, stored: Ref.get(stored) }
})

/** How a call ended, as the model would read it. */
interface CallResult {
  readonly isFailure: boolean
  readonly result: unknown
}

/** One turn over the registry, with its tools open. */
interface KitTurn {
  /** The registry's catalog. */
  readonly catalog: CapabilityCatalog
  readonly tools: RunTools
  /** Call a tool through the open toolkit's handlers at `step`, as the loop (or a host) does. */
  readonly call: (name: string, params: unknown, step?: number) => Effect.Effect<CallResult, unknown>
  /** The `tool.*` and `skills.activated` events published so far, in order. */
  readonly published: Effect.Effect<ReadonlyArray<TurnEvent>>
  /** What the turn stored so far. */
  readonly stored: Effect.Effect<ReadonlyArray<SessionLogEvent>>
  /** The tools whose handlers ran, in order. */
  readonly ran: Effect.Effect<ReadonlyArray<string>>
}

interface TurnSetup {
  readonly maxCallsPerRun?: number
  readonly policy?: Context.Service.Shape<typeof ActionPolicy>
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
 * the ones it declares (`RegisteredTool.requires`) included; a run lacking
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
    const registry = yield* make([capabilityOf(ran)], { maxCallsPerRun: setup.maxCallsPerRun ?? 32 })
    const recorded = yield* memoryWriter
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
        Effect.provideService(Opener, "the opener's"),
        (open) => setup.withoutEnvironment === true ? open.pipe(Effect.updateContext((context: Context.Context<never>) => Context.omit(SessionEnvironment)(context)))
          : open.pipe(Effect.provideService(SessionEnvironment, { workspace: "the opener's" })),
        (open) => Option.match(Option.fromNullishOr(setup.policy), { onNone: () => open, onSome: (denying) => open.pipe(Effect.provideService(ActionPolicy, denying)) }),
        (open) => Option.match(Option.fromNullishOr(setup.grants), {
          onNone: () => open,
          onSome: (grants) => open.pipe(Effect.provideService(PermissionGrants, PermissionGrants.of({ grants: Effect.succeed(new Set(grants)) }))),
        }),
      )
      const tools = yield* opening
      yield* tools.select(run.userMessage)
      const call = (name: string, params: unknown, step = 1): Effect.Effect<CallResult, unknown> => (Effect.gen(function* () {
        const kit = yield* tools.toolkit.pipe(Effect.provide(tools.handlers))
        const results = yield* Stream.runCollect(yield* kit.handle(name, params))
        const last = results.at(-1)
        return { isFailure: last?.isFailure ?? true, result: last?.result }
      }) as Effect.Effect<CallResult, unknown>).pipe(
        Effect.provideService(CurrentAgentStep, Option.some(step)),
        Effect.provideService(Opener, "the caller's"),
        Effect.provideService(SessionEnvironment, { workspace: "the caller's" }),
      )
      return yield* body({
        catalog: registry.catalog,
        tools,
        call,
        published: run.flush.pipe(Effect.orDie, Effect.andThen(Ref.get(published))),
        stored: run.flush.pipe(Effect.orDie, Effect.andThen(recorded.stored)),
        ran: Ref.get(ran),
      })
    }).pipe(Effect.provide(TurnLive({ turn: recorded.writer })), Effect.provide(services))
  }))
  const tags = (events: ReadonlyArray<TurnEvent>) => events.map((event) => event._tag).join()
  const idOf = (event: TurnEvent): string => "invocationId" in event ? event.invocationId : ""

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
