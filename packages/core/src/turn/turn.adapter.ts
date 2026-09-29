import { Context, Effect, Layer, Option, Ref, Scope } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import { fingerprintOf } from "../memory/memory-log.entity.functions.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import { readerOf } from "../memory/memory-session.js"
import { Capabilities } from "../ports/capability.port.js"
import type { Capability, PromptContext, PromptSection } from "../ports/capability.port.js"
import { ConversationMemory } from "../ports/memory.port.js"
import type { LogHandle } from "../ports/memory.port.js"
import { RunContext } from "../ports/run-context.port.js"
import type { TurnDraft } from "../ports/sessions.port.js"
import { draftOfTurnEvent, draftsOfEntries, entriesOfEvents } from "../session/session-event.entity.functions.js"
import { MEMORY_KINDS, RESERVED_KINDS } from "../session/session-event.entity.js"
import { ToolRegistry } from "../ports/tool-registry.port.js"
import type { RunTools } from "../ports/tool-registry.port.js"
import { TurnEvents, TurnTasks } from "../ports/turn-events.port.js"
import { TurnMemory, TurnPrompt, TurnToolbox } from "../ports/turn-scope.port.js"
import type { TurnLiveInput } from "../ports/turn-scope.port.js"
import { renderSections } from "./prompt-sections.js"
import { makeTurnEvents, makeTurnTasks } from "./turn-bus.js"
import type { TurnEvent } from "./turn-event.entity.js"

const failure = (code: string, message: string) => new HarnessError({ code, message })

/** Contributed sections' requirements are erased: they render with the services of their caller. */
const inCaller = <A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
  Effect.flatMap(Effect.context<never>(), (context) => effect.pipe(Effect.provide(context)) as Effect.Effect<A, E>)

/** A host event may not take a name only the framework writes. */
const storedDraft = (turn: number) => (event: TurnEvent): Option.Option<TurnDraft | HarnessError> =>
  event._tag === "host" && RESERVED_KINDS.includes(event.name)
    ? Option.some(failure("events.reserved", `${event.name} is the framework's kind`))
    : Option.map(draftOfTurnEvent(turn, event), (draft): TurnDraft => ({ kind: draft.kind, data: draft.data }))

/**
 * One admitted turn's services, over the turn's writer, built in this order:
 * the event bus and the tasks, with the writer as the bus's FIRST
 * subscriber (every stored event is queued before any reaction runs); then
 * the memory session, opened over the session's earlier memory events where
 * this layer is built (a digester or summarizer there is used), and
 * RunContext. It also holds the tools slot (`TurnToolbox`) and the prompt
 * state (`TurnPrompt`). The message was stored when the turn began; memory
 * takes it at `TurnMemory.persistMessage`. Tasks run in the layer's scope:
 * they are interrupted when it closes.
 */
export const TurnLive = (input: TurnLiveInput): Layer.Layer<
  RunContext | TurnEvents | TurnTasks | TurnMemory | TurnToolbox | TurnPrompt,
  HarnessError,
  ConversationMemory | ToolRegistry
> => Layer.effectContext(Effect.gen(function* () {
  const scope = yield* Effect.scope
  const memory = yield* ConversationMemory
  const registry = yield* ToolRegistry
  const capabilities = Option.getOrElse(yield* Effect.serviceOption(Capabilities), (): ReadonlyArray<Capability> => [])
  const sections = capabilities.flatMap((capability) => capability.promptSections)

  const writer = input.turn
  const admitted = writer.admitted
  const events = yield* makeTurnEvents({ maxDepth: input.maxEventDepth ?? 8 })
  const tasks = yield* makeTurnTasks(scope)
  // The writer is the first subscriber: every stored event is queued before any reaction runs.
  yield* events.subscribe(storedDraft(admitted.turn), (draft) => draft instanceof HarnessError ? Effect.fail(draft) : writer.append([draft]))
  // Memory's log is the session's memory events before this turn; what it records goes to the
  // same queue. Its TurnStarted is the turn's own `turn.started`, stored when the turn began.
  const log: LogHandle = {
    read: writer.history(MEMORY_KINDS).pipe(
      Effect.flatMap((stored) => entriesOfEvents(stored).pipe(Effect.mapError((error) => failure("memory.log", `undecodable memory events: ${error.message}`)))),
    ),
    append: (entries) => Effect.gen(function* () {
      const started = entries.filter((entry) => entry.body._tag === "TurnStarted")
      // The stored message is entry `<runId>:0` of turn N: memory must number it the same.
      if (started.some((entry) => entry.turn !== admitted.turn || entry.id !== writer.started.data.entry)) {
        return yield* Effect.fail(failure("turn.numbering",
          `memory took the message as ${started.map((entry) => `${entry.id} of turn ${entry.turn}`).join()}, the session stored ${String(writer.started.data.entry)} of turn ${admitted.turn}`))
      }
      const drafts = yield* draftsOfEntries(entries).pipe(Effect.mapError((error) => failure("memory.log", error.message)))
      yield* writer.append(drafts.map((draft): TurnDraft => ({ kind: draft.kind, data: draft.data })))
    }),
  }
  const session = yield* memory.open({ conversation: admitted.session.id, runId: admitted.runId, log })
  const reader = readerOf(session)

  const slot = yield* Ref.make(Option.none<RunTools>())
  const openTools = Ref.get(slot).pipe(Effect.flatMap(Option.match({
    onNone: () => Effect.fail(failure("tools.unavailable", "Tools are not open yet")),
    onSome: (tools) => Effect.succeed(tools),
  })))
  const run = RunContext.of({
    conversation: admitted.session.id,
    runId: admitted.runId,
    userMessage: admitted.userMessage,
    memory: reader,
    events,
    tasks,
    activate: (skills) => openTools.pipe(Effect.flatMap((tools) => tools.activate(skills, "host"))),
    flush: writer.flush,
    write: writer.write,
  })

  const claimed = yield* Ref.make(false)
  const started = yield* Ref.make(Option.none<number>())
  const replied = yield* Ref.make(false)
  const turnMemory = TurnMemory.of({
    ...reader,
    strategy: session.strategy,
    session,
    number: Ref.get(started).pipe(Effect.flatMap(Option.match({
      onNone: () => Effect.fail(failure("turn.unstarted", "The user's message is not persisted yet")),
      onSome: (number) => Effect.succeed(number),
    }))),
    persistMessage: Effect.gen(function* () {
      if (yield* Ref.getAndSet(claimed, true)) return yield* Effect.fail(failure("turn.persisted", "The user's message is already persisted"))
      const number = admitted.turn
      yield* session.record([{ _tag: "TurnStarted", userMessage: admitted.userMessage }], 0)
      yield* Ref.set(started, Option.some(number))
      yield* events.publish({ _tag: "turn.started", runId: admitted.runId, turn: number, userMessage: admitted.userMessage })
      return number
    }),
    context: (entry) => session.record([{ _tag: "TurnContext", sectionId: entry.id, version: entry.version, text: entry.text }], 0).pipe(Effect.asVoid),
    persistReply: (outcome) => Effect.gen(function* () {
      const number = yield* Ref.get(started)
      if (Option.isNone(number) || (yield* Ref.getAndSet(replied, true))) return
      yield* session.record([{ _tag: "TurnEnded", outcome: outcome.outcome, reply: outcome.reply }], 0)
      yield* events.publish({ _tag: "turn.ended", runId: admitted.runId, turn: number.value, outcome: outcome.outcome, reply: outcome.reply })
    }),
  })

  const opened = yield* Ref.make(false)
  const toolbox = TurnToolbox.of({
    open: Effect.gen(function* () {
      if (yield* Ref.getAndSet(opened, true)) return yield* Effect.fail(failure("tools.opened", "The turn's tools are already open"))
      const tools = yield* registry.open(session).pipe(Effect.provideService(RunContext, run), Scope.provide(scope))
      yield* Ref.set(slot, Option.some(tools))
      return tools
    }),
    tools: openTools,
  })

  const promptContext = (tools: RunTools, variant: Option.Option<string>) =>
    tools.active.pipe(Effect.map((active): PromptContext => ({ variant, active, skills: tools.skills })))
  const rendered = (tools: RunTools, variant: Option.Option<string>, tiers: (section: PromptSection) => boolean) =>
    inCaller(promptContext(tools, variant).pipe(Effect.flatMap((context) => renderSections(sections.filter(tiers), context))))
  const lastSystem = yield* Ref.make(Option.fromNullishOr((yield* session.entries).flatMap((entry: LogEntry) =>
    entry.body._tag === "SystemPrepared" ? [entry.body.fingerprint] : []).at(-1)))
  const systems = yield* Ref.make(new Map<string, string>())
  const turnSections = yield* Ref.make(false)
  const prompt = TurnPrompt.of({
    system: (variant) => Effect.gen(function* () {
      const key = Option.getOrElse(variant, () => "")
      const known = (yield* Ref.get(systems)).get(key)
      if (known !== undefined) return known
      const parts = yield* rendered(yield* openTools, variant, (section) => section.tier !== "turn")
      const text = [input.system ?? "", ...parts.map((part) => part.text)].filter((part) => part.trim().length > 0).join("\n\n")
      const fingerprint = fingerprintOf(text)
      if (!Option.contains(yield* Ref.get(lastSystem), fingerprint)) {
        yield* session.record([{
          _tag: "SystemPrepared", fingerprint, text,
          sections: parts.map((part) => ({ id: part.section.id, version: part.section.version, fingerprint: fingerprintOf(part.text) })),
        }], 0)
        yield* Ref.set(lastSystem, Option.some(fingerprint))
      }
      yield* Ref.update(systems, (all) => new Map([...all, [key, text]]))
      return text
    }),
    turnSections: Effect.gen(function* () {
      if (yield* Ref.getAndSet(turnSections, true)) return
      const parts = yield* rendered(yield* openTools, Option.none(), (section) => section.tier === "turn")
      yield* parts.length === 0 ? Effect.void : session.record(parts.map(({ section, text }) => ({
        _tag: "TurnContext" as const, sectionId: section.id, version: section.version, text,
      })), 0)
    }),
  })

  return Context.make(RunContext, run).pipe(
    Context.add(TurnEvents, events),
    Context.add(TurnTasks, tasks),
    Context.add(TurnMemory, turnMemory),
    Context.add(TurnToolbox, toolbox),
    Context.add(TurnPrompt, prompt),
  )
}))
