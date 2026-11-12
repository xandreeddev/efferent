// The lesson runtime: the kernel, running in the page. The base (events, the
// journal, sessions) is built once in a root scope, and the page listens on
// its Core once. Each rebuild evaluates the learner's agent expression and
// builds it in a child scope over the base and the loaded model; the previous
// child scope is closed first, so no event reaches two agents.
import { Cause, Context, Effect, Exit, Layer, Option, Predicate, Scope } from "effect"
import { LanguageModel } from "effect/ai"
import { Core, kernel, messageOf, readerFor, readJournal, Sessions, turnEndedEvent, turnStartedEvent } from "@xandreed/core/kernel"
import type { Delivered, JournalStorage, SessionId, StoredEvent, TurnOutcome } from "@xandreed/core/kernel"
import {
  assistantDeltaEvent, assistantMessageEvent, estimateRequest, Inbox, inbox, inboxQueuedEvent, inProcessJournal, isOverBudget, LOOP_READER,
  Memory, OverBudget, requestSentEvent, sessions, settings, Settings, stepLoop, Tokens, userMessageEvent, windowDroppedEvent, windowMemory,
  windowPressureEvent,
} from "@xandreed/sdk/kernel"
import type { Reply } from "@xandreed/sdk/kernel"
import type { LoadedModel } from "./models/types.ts"

const OWNER = "learner"

type BaseServices = Sessions | JournalStorage | Core
type InboxShape = Context.Service.Shape<typeof Inbox>

/**
 * What the learner's expression must be: a layer over the base and the
 * model. Only that it is a layer is checked here; what it needs is checked
 * when it is built (a missing part fails the build with "Service not
 * found"), and that it provides an inbox after.
 */
type UpperStack = Layer.Layer<unknown, unknown, BaseServices | LanguageModel.LanguageModel>
const isUpperStack = (value: unknown): value is UpperStack => Layer.isLayer(value)

/** What the page hears of the agent, one entry per kernel event it listens to. `name` is the kernel's own event name. */
export type LessonEvent =
  | { readonly _tag: "Queued"; readonly name: string; readonly id: number; readonly ticket: number; readonly text: string }
  | { readonly _tag: "TurnStarted"; readonly name: string; readonly turn: number }
  | { readonly _tag: "UserMessage"; readonly name: string; readonly turn: number; readonly id: Option.Option<number>; readonly text: string }
  | { readonly _tag: "RequestSent"; readonly name: string; readonly turn: number; readonly step: number; readonly messages: number; readonly estimatedTokens: number; readonly budgetTokens: number }
  | { readonly _tag: "Delta"; readonly name: string; readonly turn: number; readonly text: string }
  | { readonly _tag: "AssistantMessage"; readonly name: string; readonly turn: number; readonly step: number; readonly text: string }
  | { readonly _tag: "TurnEnded"; readonly name: string; readonly turn: number; readonly outcome: TurnOutcome }
  | { readonly _tag: "WindowDropped"; readonly name: string; readonly turn: number; readonly through: number }
  | { readonly _tag: "WindowPressure"; readonly name: string; readonly turn: number; readonly estimatedTokens: number; readonly budgetTokens: number }

export type BuildResult =
  | { readonly _tag: "Built" }
  | { readonly _tag: "Refused"; readonly message: string }

/** How one queued message ended. Failures stay told apart: over the budget, stopped, refused, or anything else. */
export type SendOutcome =
  | { readonly _tag: "Replied"; readonly text: string }
  | { readonly _tag: "OverBudget"; readonly estimatedTokens: number; readonly budgetTokens: number; readonly message: string }
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Refused"; readonly message: string }
  | { readonly _tag: "Failed"; readonly message: string }

/** A message the page sent: its own id (tickets start again with each inbox), its text, and how it ends. */
export interface Sent {
  readonly id: number
  readonly text: string
  readonly outcome: Promise<SendOutcome>
}

/** The names the memory's code may use (see tiny-memory.source.ts). */
const tinyNames = { Effect, Layer, Option, messageOf, readerFor, readJournal, estimateRequest, LOOP_READER, Memory, OverBudget, Settings, Tokens }

/** Evaluate a JavaScript expression against a fixed set of names only. */
const evaluate = (source: string, names: Record<string, unknown>): unknown => {
  const keys = Object.keys(names)
  return new Function(...keys, `"use strict"; return (${source}\n)`)(...keys.map((key) => names[key]))
}

const textOf = (error: unknown): string =>
  error instanceof Error ? error.message
    : Predicate.hasProperty(error, "message") && Predicate.isString(error.message) ? error.message
      : String(error)

/** Evaluate the learner's memory file: a function that makes a memory layer. */
export const evaluateTiny = (source: string): unknown => evaluate(source, tinyNames)

/** Evaluate the learner's agent expression; `lastMessages` is the learner's own memory, when the agent uses it. */
export const evaluateAgent = (source: string, lastMessages: unknown = undefined): unknown =>
  evaluate(source, { Layer, inbox, stepLoop, windowMemory, settings, lastMessages })

/** Why a build failed, in words: the error a part failed with, or the defect (a missing service is one). */
const buildFailure = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause)
  const reason = Option.isSome(failure) ? textOf(failure.value) : Cause.prettyErrors(cause)[0]?.message ?? "the stack did not build"
  const missing = /Service not found: (\S+)/.exec(reason)?.[1]
  return missing === undefined ? reason
    : `nothing in the stack provides ${missing.split("/").at(-1)}, and a part above it needs it (${reason}).`
}

/** A reply's end as the page shows it. */
const outcomeOf = (reply: Effect.Effect<Reply, unknown>): Effect.Effect<SendOutcome> => Effect.matchCause(reply, {
  onSuccess: (done): SendOutcome => ({ _tag: "Replied", text: done.text }),
  onFailure: (cause): SendOutcome => {
    if (Cause.hasInterruptsOnly(cause)) return { _tag: "Stopped" }
    const failure = Cause.findErrorOption(cause)
    if (Option.isNone(failure)) return { _tag: "Failed", message: Cause.prettyErrors(cause)[0]?.message ?? "the turn failed" }
    const error = failure.value
    if (isOverBudget(error)) return { _tag: "OverBudget", estimatedTokens: error.estimatedTokens, budgetTokens: error.budgetTokens, message: error.message }
    if (Predicate.isTagged(error, "InboxClosed")) return { _tag: "Stopped" }
    return { _tag: "Failed", message: textOf(error) }
  },
})

export class LessonRuntime {
  private upper: Option.Option<{ readonly scope: Scope.Closeable; readonly inbox: InboxShape }> = Option.none()
  private model: Option.Option<LoadedModel> = Option.none()
  private readonly listeners = new Set<(event: LessonEvent) => void>()
  /** Messages handed to `enqueue` whose `plugin.inbox.queued` has not been heard yet, in call order. */
  private announcing: Array<{ readonly id: number; readonly text: string }> = []
  /** Messages queued whose turn has not stored the user's message yet, in ticket order. */
  private waiting: Array<{ readonly id: number; readonly text: string; readonly ticket: number }> = []
  private nextId = 1
  private unsettled = 0
  /** A rebuild asked for while replies were unsettled: the latest source, and whoever waits for its result. */
  private deferred: Option.Option<{ agent: string; tiny: string; readonly waiters: Array<(result: BuildResult) => void> }> = Option.none()
  private last = { agent: "", tiny: "" }

  private constructor(
    private readonly root: Scope.Closeable,
    private readonly base: Context.Context<BaseServices>,
    private session: SessionId,
  ) {}

  static async create(): Promise<LessonRuntime> {
    const root = await Effect.runPromise(Scope.make())
    const Base = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))
    const base = await Effect.runPromise(Layer.buildWithScope(Base, root))
    const session = await Effect.runPromise(Context.get(base, Sessions).create({ owner: OWNER }))
    const runtime = new LessonRuntime(root, base, session)
    await Effect.runPromise(runtime.listen().pipe(Effect.provideService(Scope.Scope, root)))
    return runtime
  }

  /** Hear what the agent does. Returns the unsubscribe. */
  onEvent(listener: (event: LessonEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: LessonEvent): Effect.Effect<void> {
    return Effect.forEach(this.listeners, (listener) => Effect.try({ try: () => listener(event), catch: (error) => error }).pipe(
      Effect.ignore({ log: "Warn", message: "a lesson page listener failed" }),
    ), { concurrency: 1, discard: true })
  }

  /** The page's listeners, registered once on the base's Core. Each is waited for, so the page hears events in the order they were published. */
  private listen(): Effect.Effect<void, never, Scope.Scope> {
    const core = Context.get(this.base, Core)
    const options = { name: "page", wait: true } as const
    const turnOf = (event: { readonly turn?: number }) => event.turn ?? 0
    /** The text of the message a stored record bears; a live event bears none. */
    const textOn = (event: Delivered<unknown>) => "message" in event ? Option.match(messageOf(event), { onNone: () => "", onSome: (message) => message.text }) : ""
    return Effect.all([
      core.on(inboxQueuedEvent, (event) => Effect.suspend(() => {
        const next = this.announcing.shift()
        if (next === undefined) return Effect.void
        this.waiting.push({ ...next, ticket: event.data.ticket })
        return this.emit({ _tag: "Queued", name: inboxQueuedEvent.name, id: next.id, ticket: event.data.ticket, text: next.text })
      }), options),
      core.on(turnStartedEvent, (event) => this.emit({ _tag: "TurnStarted", name: turnStartedEvent.name, turn: event.data.turn }), options),
      core.on(userMessageEvent, (event) => Effect.suspend(() => {
        const started = this.waiting.shift()
        return this.emit({
          _tag: "UserMessage", name: userMessageEvent.name, turn: turnOf(event), id: Option.map(Option.fromNullishOr(started), (entry) => entry.id),
          text: textOn(event),
        })
      }), options),
      core.on(requestSentEvent, (event) => this.emit({
        _tag: "RequestSent", name: requestSentEvent.name, turn: turnOf(event), step: event.data.step, messages: event.data.messages.length,
        estimatedTokens: event.data.estimatedTokens, budgetTokens: event.data.budgetTokens,
      }), options),
      core.on(assistantDeltaEvent, (event) => this.emit({ _tag: "Delta", name: assistantDeltaEvent.name, turn: turnOf(event), text: event.data.text }), options),
      core.on(assistantMessageEvent, (event) => this.emit({
        _tag: "AssistantMessage", name: assistantMessageEvent.name, turn: turnOf(event), step: event.data.step,
        text: textOn(event),
      }), options),
      core.on(turnEndedEvent, (event) => this.emit({ _tag: "TurnEnded", name: turnEndedEvent.name, turn: event.data.turn, outcome: event.data.outcome }), options),
      core.on(windowDroppedEvent, (event) => this.emit({ _tag: "WindowDropped", name: windowDroppedEvent.name, turn: turnOf(event), through: event.data.through }), options),
      core.on(windowPressureEvent, (event) => this.emit({
        _tag: "WindowPressure", name: windowPressureEvent.name, turn: turnOf(event), estimatedTokens: event.data.estimatedTokens, budgetTokens: event.data.budgetTokens,
      }), options),
    ], { concurrency: 1, discard: true })
  }

  /** The model the next rebuild hands the agent. */
  setModel(model: LoadedModel): void {
    this.model = Option.some(model)
  }

  /** Whether any queued message is still waiting for its reply. */
  get busy(): boolean {
    return this.unsettled > 0
  }

  /** Whether an agent is built and can take messages. */
  get ready(): boolean {
    return Option.isSome(this.upper) && Option.isSome(this.model)
  }

  /**
   * Build the learner's agent over the base. While a reply is unsettled the
   * rebuild waits, and the latest source asked for is the one built once
   * every reply has settled; the promise resolves then.
   */
  rebuild(agent: string, tiny: string): Promise<BuildResult> {
    if (!this.busy) return this.build(agent, tiny)
    return new Promise((resolve) => {
      this.deferred = Option.some(Option.match(this.deferred, {
        onNone: () => ({ agent, tiny, waiters: [resolve] }),
        onSome: (pending) => ({ agent, tiny, waiters: [...pending.waiters, resolve] }),
      }))
    })
  }

  private async closeUpper(): Promise<void> {
    const upper = this.upper
    this.upper = Option.none()
    if (Option.isSome(upper)) await Effect.runPromise(Scope.close(upper.value.scope, Exit.void))
  }

  private async build(agent: string, tiny: string): Promise<BuildResult> {
    this.last = { agent, tiny }
    await this.closeUpper()
    if (Option.isNone(this.model)) return { _tag: "Refused", message: "Pick a model first." }
    let lastMessages: unknown = undefined
    if (agent.includes("lastMessages")) {
      const made = Effect.runSync(Effect.exit(Effect.try({ try: () => evaluateTiny(tiny), catch: textOf })))
      if (Exit.isFailure(made)) return { _tag: "Refused", message: `tiny-memory.ts is not valid JavaScript: ${buildFailure(made.cause)}` }
      lastMessages = made.value
    }
    const evaluated = Effect.runSync(Effect.exit(Effect.try({ try: () => evaluateAgent(agent, lastMessages), catch: textOf })))
    if (Exit.isFailure(evaluated)) return { _tag: "Refused", message: `This is not a valid expression: ${buildFailure(evaluated.cause)}` }
    const stack = evaluated.value
    if (!isUpperStack(stack)) return { _tag: "Refused", message: "The agent must be a layer, such as inbox.pipe(...)." }
    const services = Context.add(this.base, LanguageModel.LanguageModel, this.model.value.model)
    const scope = await Effect.runPromise(Scope.fork(this.root))
    const built = await Effect.runPromiseExit(Layer.buildWithScope(stack, scope).pipe(Effect.provide(services)))
    if (Exit.isFailure(built)) {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      return { _tag: "Refused", message: buildFailure(built.cause) }
    }
    const provided = Context.getOption(built.value, Inbox)
    if (Option.isNone(provided)) {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      return { _tag: "Refused", message: "The stack provides no Inbox: start it with inbox.pipe(...)." }
    }
    this.upper = Option.some({ scope, inbox: provided.value })
    return { _tag: "Built" }
  }

  /** Queue messages, in order, without waiting: each is answered in a turn of its own. */
  async send(texts: ReadonlyArray<string>): Promise<ReadonlyArray<Sent>> {
    const entries = texts.map((text) => ({ id: this.nextId++, text }))
    if (Option.isNone(this.upper)) {
      return entries.map((entry) => ({ ...entry, outcome: Promise.resolve<SendOutcome>({ _tag: "Refused", message: "Build the agent first." }) }))
    }
    const target = this.upper.value.inbox
    const session = this.session
    const queued = await Effect.runPromise(Effect.forEach(entries, (entry) => Effect.suspend(() => {
      this.announcing.push(entry)
      return target.enqueue(session, entry.text).pipe(
        Effect.map((ticket) => ({ entry, outcome: outcomeOf(ticket.reply) })),
        Effect.catchTag("InboxRefused", (refused) => Effect.sync(() => {
          this.announcing = this.announcing.filter((pending) => pending !== entry)
          return { entry, outcome: Effect.succeed<SendOutcome>({ _tag: "Refused", message: refused.message }) }
        })),
      )
    }), { concurrency: 1 }))
    return queued.map(({ entry, outcome }) => {
      this.unsettled += 1
      const settled = Effect.runPromise(outcome).then((result) => {
        // A message that never reached its turn (stopped while it waited) leaves the queue the page draws.
        this.waiting = this.waiting.filter((pending) => pending.id !== entry.id)
        this.announcing = this.announcing.filter((pending) => pending.id !== entry.id)
        this.unsettled -= 1
        if (this.unsettled === 0) void this.runDeferred()
        return result
      })
      return { ...entry, outcome: settled }
    })
  }

  private async runDeferred(): Promise<void> {
    const pending = this.deferred
    this.deferred = Option.none()
    if (Option.isNone(pending)) return
    const result = await this.build(pending.value.agent, pending.value.tiny)
    pending.value.waiters.forEach((resolve) => resolve(result))
  }

  /**
   * Stop: tell the model to stop, close the agent's scope (the running turn
   * ends `Interrupted`, the session is free, and every waiting reply fails
   * with `InboxClosed`), then build the agent again from the latest source.
   */
  async stop(): Promise<BuildResult> {
    // Taken first: the replies the close settles must not start a rebuild of their own.
    const pending = this.deferred
    this.deferred = Option.none()
    if (Option.isSome(this.model)) this.model.value.interrupt()
    await this.closeUpper()
    const source = Option.match(pending, { onNone: () => this.last, onSome: (value) => ({ agent: value.agent, tiny: value.tiny }) })
    const result = await this.build(source.agent, source.tiny)
    if (Option.isSome(pending)) pending.value.waiters.forEach((resolve) => resolve(result))
    return result
  }

  /** A new, empty session in the same base. The old one stays in the journal store. */
  async clear(): Promise<void> {
    this.session = await Effect.runPromise(Context.get(this.base, Sessions).create({ owner: OWNER }))
    this.announcing = []
    this.waiting = []
  }

  /** The session's journal, as stored. */
  async journal(): Promise<ReadonlyArray<StoredEvent>> {
    const journal = await Effect.runPromise(Context.get(this.base, Sessions).read(this.session))
    return journal.events
  }

  async dispose(): Promise<void> {
    await this.closeUpper()
    await Effect.runPromise(Scope.close(this.root, Exit.void))
  }
}
