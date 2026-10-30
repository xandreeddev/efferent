import { Context, Effect, Layer, Match, Option, Ref, Result, Schema, Scope, Semaphore } from "effect"
import {
  addUsage,
  Capabilities,
  ConversationMemory,
  entriesOfEvents,
  fingerprintOf,
  frameworkDraft,
  HarnessError,
  makeTurnEvents,
  makeTurnTasks,
  MEMORY_KINDS,
  ModelRequestHeader,
  readStoredKeys,
  RESERVED_KINDS,
  RunContext,
  SectionId,
  storedJson,
  ToolRegistry,
  TurnEvents,
  TurnMemory,
  TurnPrompt,
  TurnTasks,
  TurnToolbox,
  zeroUsage,
} from "@xandreed/core"
import type {
  Capability,
  LogEntry,
  LogHandle,
  PromptContext,
  PromptSection,
  RequestSnapshot,
  RunTools,
  SessionLogEvent,
  TurnContextBody,
  TurnContextEntry,
  TurnDraft,
  TurnError,
  TurnEvent,
  TurnLiveInput,
} from "@xandreed/core"
import { draftOfTurnEvent, draftsOfEntries, readerOf, renderSections } from "@xandreed/core/internal"
import { ReplyStep } from "./turn-phase.entity.js"
import type { TurnPhase } from "./turn-phase.entity.js"
import { addContext, claim, heldWith, hold, numberOf, release, reply, sectionsDue, startRun, take } from "./turn-phase.entity.functions.js"
import type { Transition } from "./turn-phase.entity.functions.js"

const failure = (code: string, message: string) => new HarnessError({ code, message })

/**
 * A bus event as the turn stores it, when it is stored. A host event may not
 * take a name only the framework writes (`events.reserved`); an event its
 * schema does not encode fails the turn with `events.encode`. What the bus
 * stores is the framework's draft.
 */
const storedDraft = (turn: number) => (event: TurnEvent): Effect.Effect<Option.Option<TurnDraft>, HarnessError> =>
  event._tag === "host" && RESERVED_KINDS.includes(event.name)
    ? Effect.fail(failure("events.reserved", `${event.name} is the framework's kind`))
    : draftOfTurnEvent(turn, event).pipe(
      Effect.mapError((error) => failure("events.encode", `${event._tag} does not encode: ${error.message}`)),
      Effect.map(Option.map((draft): TurnDraft => frameworkDraft(draft.kind, draft.data))),
    )

const contextBody = (entry: TurnContextEntry): TurnContextBody => ({ _tag: "TurnContext", sectionId: SectionId.make(entry.id), version: entry.version, text: entry.text })

/** The turn's tools: not open, being opened (`TurnToolbox.open`), or open. An open that fails leaves them closed. */
type ToolSlot =
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Opening" }
  | { readonly _tag: "Open"; readonly tools: RunTools }

/**
 * One admitted turn's services, over the turn's writer, built in this order:
 * the event bus and the tasks, with the writer as the bus's FIRST
 * subscriber (every stored event is queued before any reaction runs) and
 * the turn's usage (`RunContext.usage`) as the second; then the memory
 * session, opened over the session's earlier memory events where this
 * layer is built (a digester or summarizer there is used), and RunContext.
 * It also holds the tools slot (`TurnToolbox`) and the prompt state
 * (`TurnPrompt`). Where the turn stands is one `TurnPhase`, moved by the
 * pure transitions of `turn-phase.entity.functions.ts`; what a transition
 * plans (a record, a publish) runs after it. The message was stored when
 * the turn began; memory takes it at `TurnMemory.persistMessage`, and
 * records nothing before it (`TurnMemory.context` waits for it). Its
 * reply, and what memory records after it, the writer holds for the turn's
 * closing commit (`TurnWriter.closing`), stored with `turn.ended`; a failed
 * reply after a completed one holds it again, failed, under its own id.
 * Tasks run in the layer's scope: they are interrupted when it closes.
 * `TurnMemory.persistReply` runs under its span, `turn.persist_reply`
 * (inline `turn.ended` subscribers' spans nest under it).
 */
export const TurnLive = (input: TurnLiveInput): Layer.Layer<
  RunContext | TurnEvents | TurnTasks | TurnMemory | TurnToolbox | TurnPrompt,
  TurnError,
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
  yield* events.subscribe(Option.some, (event: TurnEvent) => storedDraft(admitted.turn)(event).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (draft) => writer.append([draft]) })),
  ))
  // The turn's usage: what its stored `step.usage` records hold, summed as they are queued.
  const usage = yield* Ref.make(zeroUsage)
  yield* events.subscribe(
    (event) => event._tag === "assistant.message" ? Option.some(event.usage) : Option.none(),
    (step) => Ref.update(usage, (total) => addUsage(total, step)),
  )
  const phase = yield* Ref.make<TurnPhase>({ _tag: "Waiting", early: [] })
  /** Apply a transition: the phase moves and what it returns is returned; a refusal fails, the phase as it was. */
  const transition = <A>(decide: (current: TurnPhase) => Transition<A>): Effect.Effect<A, HarnessError> =>
    Ref.modify(phase, (current) => Result.match(decide(current), {
      onFailure: (error): readonly [Result.Result<A, HarnessError>, TurnPhase] => [Result.fail(error), current],
      onSuccess: ([value, next]): readonly [Result.Result<A, HarnessError>, TurnPhase] => [Result.succeed(value), next],
    })).pipe(Effect.flatMap(Effect.fromResult))
  // What memory was opened over, as stored: the base of every request snapshot.
  const history = yield* Ref.make(Option.none<ReadonlyArray<LogEntry>>())
  const decoded = (stored: ReadonlyArray<SessionLogEvent>) =>
    entriesOfEvents(stored).pipe(Effect.mapError((error) => failure("memory.log", `undecodable memory events: ${error.message}`)))
  const readHistory = writer.history(MEMORY_KINDS).pipe(Effect.flatMap(decoded))
  /** The memory entry the session stored the turn's message as: its `turn.started`'s keys. */
  const storedEntry = readStoredKeys("turn.started", [writer.started]).pipe(
    Effect.map((starts) => starts.map((started) => started.keys.entry)),
    Effect.mapError((error) => failure("memory.log", `undecodable turn.started: ${error.message}`)),
  )
  const draftsOf = (entries: ReadonlyArray<LogEntry>) => draftsOfEntries(entries).pipe(
    Effect.mapError((error) => failure("memory.log", error.message)),
    Effect.map((drafts) => drafts.map((draft): TurnDraft => frameworkDraft(draft.kind, draft.data))),
  )
  /** Orders what the writer holds for the closing commit: the phase keeps what `closing` took last. */
  const holding = yield* Semaphore.make(1)
  /** Hand the writer these entries as the turn's closing drafts (they replace what it held), then keep them. */
  const holdNow = (held: ReadonlyArray<LogEntry>) =>
    draftsOf(held).pipe(Effect.flatMap(writer.closing), Effect.andThen(Ref.update(phase, hold(held))))
  // Memory's log is the session's memory events before this turn; what it records goes to the
  // same queue, but its reply, and what it records after it, waits for the turn's closing commit
  // (`TurnWriter.closing`). Its TurnStarted is the turn's own `turn.started`, stored when the turn began.
  const log: LogHandle = {
    read: readHistory.pipe(Effect.tap((entries) => Ref.set(history, Option.some(entries)))),
    append: Effect.fnUntraced(function* (entries) {
      // Nothing of the turn precedes its message: an entry recorded before it would take the message's number.
      if (Option.isNone(numberOf(yield* Ref.get(phase))) && entries.some((entry) => entry.body._tag !== "TurnStarted")) {
        return yield* Effect.fail(failure("turn.unstarted", "memory records nothing before the turn's message is taken (persistMessage); TurnMemory.context waits for it"))
      }
      const started = entries.filter((entry) => entry.body._tag === "TurnStarted")
      // The stored message is entry `<runId>:0` of turn N: memory must number it the same.
      const stored = started.length === 0 ? [] : yield* storedEntry
      if (started.some((entry) => entry.turn !== admitted.turn || !stored.includes(entry.id))) {
        return yield* Effect.fail(failure("turn.numbering",
          `memory took the message as ${started.map((entry) => `${entry.id} of turn ${entry.turn}`).join()}, the session stored ${stored.join()} of turn ${admitted.turn}`))
      }
      yield* holding.withPermits(1)(Ref.get(phase).pipe(Effect.flatMap((current) => Option.match(heldWith(entries)(current), {
        onNone: () => draftsOf(entries).pipe(Effect.flatMap(writer.append)),
        onSome: holdNow,
      }))))
    }),
  }
  const session = yield* memory.open({ conversation: admitted.session.id, runId: admitted.runId, log })
  const reader = readerOf(session)

  const slot = yield* Ref.make<ToolSlot>({ _tag: "Closed" })
  const unavailable = Effect.fail(failure("tools.unavailable", "Tools are not open yet"))
  const openTools = Ref.get(slot).pipe(Effect.flatMap((current) => Match.valueTags(current, {
    Closed: () => unavailable,
    Opening: () => unavailable,
    Open: ({ tools }) => Effect.succeed(tools),
  })))
  const run = RunContext.of({
    conversation: admitted.session.id,
    session: admitted.session,
    runId: admitted.runId,
    userMessage: admitted.userMessage,
    admitted,
    memory: reader,
    events,
    tasks,
    activate: (skills) => openTools.pipe(Effect.flatMap((tools) => tools.activate(skills, "host"))),
    flush: writer.flush,
    write: writer.write,
    usage: Ref.get(usage),
  })

  // The request snapshot: the history memory was opened over, then the turn's stored events,
  // each read taking only what was stored after the last event it saw.
  const requestKinds = [...MEMORY_KINDS, "request.prepared"]
  const snapshots = yield* Semaphore.make(1)
  const snapshot = yield* Ref.make(Option.none<RequestSnapshot & { readonly cursor: number }>())
  const requestSnapshot: Effect.Effect<RequestSnapshot, TurnError> = snapshots.withPermits(1)(Effect.gen(function* () {
    const known = yield* Option.match(yield* Ref.get(snapshot), {
      onNone: () => Ref.get(history).pipe(
        Effect.flatMap(Option.match({ onNone: () => readHistory, onSome: Effect.succeed })),
        Effect.map((entries) => ({ entries, requests: [], cursor: writer.started.seq - 1 })),
      ),
      onSome: Effect.succeed,
    })
    const stored = yield* writer.snapshot(requestKinds, known.cursor)
    const headers = yield* readStoredKeys("request.prepared", stored).pipe(Effect.mapError((error) => failure("request.decode", error.message)))
    const next = {
      entries: [...known.entries, ...(yield* decoded(stored.filter((event) => MEMORY_KINDS.includes(event.kind))))],
      requests: [...known.requests, ...headers.flatMap((header) => header.keys.runId === admitted.runId ? [header.event] : [])],
      cursor: stored.reduce((last, event) => Math.max(last, event.seq), known.cursor),
    }
    yield* Ref.set(snapshot, Option.some(next))
    return { entries: next.entries, requests: next.requests }
  }))

  const recordContext = (bodies: ReadonlyArray<TurnContextBody>) => bodies.length === 0 ? Effect.void : session.record(bodies, 0).pipe(Effect.asVoid)
  const turnMemory = TurnMemory.of({
    ...reader,
    strategy: session.strategy,
    session,
    prepareRequest: (header) => Schema.encodeEffect(ModelRequestHeader)(header).pipe(
      Effect.flatMap(storedJson),
      Effect.mapError((error) => failure("request.encode", error.message)),
      Effect.flatMap((data) => writer.append([frameworkDraft("request.prepared", data)])),
      Effect.andThen(writer.flush),
    ),
    requestSnapshot,
    number: Ref.get(phase).pipe(Effect.flatMap((current) => Option.match(numberOf(current), {
      onNone: () => Effect.fail(failure("turn.unstarted", "The user's message is not persisted yet")),
      onSome: (number) => Effect.succeed(number),
    }))),
    startRun: transition(startRun(admitted.runId)),
    persistMessage: Effect.gen(function* () {
      yield* transition(claim)
      const number = admitted.turn
      // A message memory did not record waits again, with its context entries, to be taken.
      yield* session.record([{ _tag: "TurnStarted", userMessage: admitted.userMessage }], 0).pipe(Effect.onError(() => Ref.update(phase, release)))
      yield* recordContext(yield* transition(take(number)))
      yield* events.publish({
        _tag: "turn.started", runId: admitted.runId, turn: number, userMessage: admitted.userMessage, meta: admitted.meta,
        ...(admitted.resumes === undefined ? {} : { resumes: admitted.resumes }),
      })
      return number
    }),
    context: (entry) => transition(addContext(contextBody(entry))).pipe(Effect.flatMap(recordContext)),
    persistReply: Effect.fn("turn.persist_reply")(function* (outcome) {
      // A downgrade holds the entries again under the same permit as memory's records, so neither replaces the other's.
      const step = yield* holding.withPermits(1)(transition(reply(outcome.outcome)).pipe(
        Effect.tap((next) => ReplyStep.guards.Hold(next) ? holdNow(next.held) : Effect.void),
      ))
      if (!ReplyStep.guards.Record(step)) return
      yield* session.record([{ _tag: "TurnEnded", outcome: outcome.outcome, reply: outcome.reply }], 0)
      yield* events.publish({ _tag: "turn.ended", runId: admitted.runId, turn: step.number, outcome: outcome.outcome, reply: outcome.reply, usage: yield* Ref.get(usage) })
    }),
  })

  const toolbox = TurnToolbox.of({
    open: Effect.gen(function* () {
      const closed = yield* Ref.modify(slot, (current): readonly [boolean, ToolSlot] => current._tag === "Closed" ? [true, { _tag: "Opening" }] : [false, current])
      if (!closed) return yield* Effect.fail(failure("tools.opened", "The turn's tools are already open"))
      const tools = yield* registry.open(session).pipe(
        Effect.provideService(RunContext, run),
        Scope.provide(scope),
        Effect.onError(() => Ref.set(slot, { _tag: "Closed" })),
      )
      yield* Ref.set(slot, { _tag: "Open", tools })
      return tools
    }),
    tools: openTools,
  })

  const promptContext = (tools: RunTools, variant: Option.Option<string>) =>
    tools.active.pipe(Effect.map((active): PromptContext => ({ variant, active, skills: tools.skills })))
  // Each section reads the services it declares (`definePromptSection`) from where it renders: the caller's.
  const rendered = (tools: RunTools, variant: Option.Option<string>, tiers: (section: PromptSection) => boolean) =>
    promptContext(tools, variant).pipe(Effect.flatMap((context) => renderSections(sections.filter(tiers), context)))
  const lastSystem = yield* Ref.make(Option.fromNullishOr((yield* session.entries).flatMap((entry: LogEntry) =>
    entry.body._tag === "SystemPrepared" ? [entry.body.fingerprint] : []).at(-1)))
  const systems = yield* Ref.make(new Map<string, string>())
  const prompt = TurnPrompt.of({
    system: Effect.fnUntraced(function* (variant) {
      const key = Option.getOrElse(variant, () => "")
      const known = (yield* Ref.get(systems)).get(key)
      if (known !== undefined) return known
      const parts = yield* rendered(yield* openTools, variant, (section) => section.tier !== "turn")
      const text = [input.system ?? "", ...parts.map((part) => part.text)].filter((part) => part.trim().length > 0).join("\n\n")
      const fingerprint = fingerprintOf(text)
      if (!Option.contains(yield* Ref.get(lastSystem), fingerprint)) {
        yield* session.record([{
          _tag: "SystemPrepared", fingerprint, text,
          sections: parts.map((part) => ({ id: SectionId.make(part.section.id), version: part.section.version, fingerprint: fingerprintOf(part.text) })),
        }], 0)
        yield* Ref.set(lastSystem, Option.some(fingerprint))
      }
      yield* Ref.update(systems, (all) => new Map([...all, [key, text]]))
      return text
    }),
    turnSections: Effect.gen(function* () {
      if (!(yield* transition(sectionsDue))) return
      const parts = yield* rendered(yield* openTools, Option.none(), (section) => section.tier === "turn")
      yield* parts.length === 0 ? Effect.void : session.record(parts.map(({ section, text }) => ({
        _tag: "TurnContext" as const, sectionId: SectionId.make(section.id), version: section.version, text,
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
