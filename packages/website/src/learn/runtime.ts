// The lesson runtime: the kernel, running in the page, and the learner's
// program over it. The base (events, the journal, sessions) and the chat's
// queue and conversation are built once in a root scope; each build runs the
// learner's program as one long-running fiber over them, its modules handed
// stand-ins for the base layers it names, so the conversation outlives
// every rebuild. What happens is traced for the page: every event on Core,
// what memory built for each turn, every prompt the model received, and
// what the program told the chat. A prompt is traced with the session and
// turn its call runs in, read from `CurrentTurn` as the model's stream runs:
// the kernel's `modelAnswer` provides it, and the summary memory does around
// its summarizer. A program that calls the model by hand (lessons 1 and 2)
// provides none, and the page falls back to the session memory was last
// asked about. A tool that asks before it acts (lesson 9) asks the page:
// its question is traced, waits for `decide`, and is traced again when it
// no longer waits, answered or dropped with its turn. A session other than
// the chat's that a turn opens in (a helper's, the memory session) is named
// with its header before that turn's first record is heard.
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Result, Scope, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { Core, JournalStorage, JournalStorageError, kernel, SessionId, Sessions, turnEndedEvent, turnStartedEvent } from "@xandreed/core/kernel"
import type { KernelEvent, StoredEvent } from "@xandreed/core/kernel"
import { Approval, CurrentTurn, inProcessJournal, Memory, sessions, Summarizer } from "@xandreed/sdk/kernel"
import type { Decision, KeyValueStore } from "@xandreed/sdk/kernel"
import { buildFailure, textOf } from "./evaluate.ts"
import type { Lesson, PageParts, Sources } from "./lesson.ts"
import type { LoadedModel } from "./models/types.ts"
import { Chat } from "./page-chat.ts"
import { saidOfMessage } from "./said.ts"

const OWNER = "learner"

/** What a durable lesson's runtime shows before its program has named a conversation: no session has this id. */
export const NO_CONVERSATION = SessionId.make("no-conversation-yet")

/** How a runtime is made. */
export interface RuntimeOptions {
  /** A durable lesson's storage: the browser's `localStorage` on the page, a value of the test's own in a test. */
  readonly storage?: KeyValueStore
}

/** Strings by key, kept in the page: what a durable lesson runs on where no storage was given. */
const memoryStore = (): KeyValueStore => {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

/** A storage seen through a prefix: every key the view reads or writes starts with it, and it lists no other. */
export const prefixed = (storage: KeyValueStore, prefix: string): KeyValueStore => {
  const keys = () => Array.from({ length: storage.length }, (_, index) => storage.key(index)).flatMap((key) => key !== null && key.startsWith(prefix) ? [key.slice(prefix.length)] : [])
  return {
    get length() { return keys().length },
    key: (index) => keys()[index] ?? null,
    getItem: (key) => storage.getItem(`${prefix}${key}`),
    setItem: (key, value) => { storage.setItem(`${prefix}${key}`, value) },
    removeItem: (key) => { storage.removeItem(`${prefix}${key}`) },
  }
}

/** One check of a kit, as the page lists it. */
export interface KitResult {
  readonly id: string
  readonly name: string
  readonly passed: boolean
  /** What the check found, when it failed. */
  readonly message: string
}

/**
 * A message as the page shows it: who it is from, its text, and the key that matches it to the record it came
 * from (a tool call and a result have no text of their own to match by: they match by the call's id).
 */
export interface Said {
  readonly role: string
  readonly text: string
  readonly key: string
  /** The tool calls a model's message makes, by id. */
  readonly callIds?: ReadonlyArray<string>
  /** The call a tool's result answers. */
  readonly resultId?: string
  /** A model's message's own text, without its calls. */
  readonly body?: string
}

/** What the provider said a call cost, when it said. */
export interface Reported {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cachedInputTokens?: number
}

/** What the page learns of the program as it runs. */
export type Trace =
  /** Every event on Core: a stored record as it is announced, or a live event. */
  | { readonly _tag: "Event"; readonly event: KernelEvent }
  /** What memory built for a session's turn: the messages after the system text, from the journal as it was up to record `upTo`. */
  | { readonly _tag: "Context"; readonly session: string; readonly turn: number; readonly upTo: number; readonly messages: ReadonlyArray<Said> }
  /**
   * A prompt the model received, for the session's turn open when it was sent, and the tools offered with it. A
   * summarizer's (`purpose: "summary"`) was sent while memory compacted, not by the turn's loop.
   */
  | { readonly _tag: "Prompt"; readonly session: string; readonly turn: number; readonly messages: ReadonlyArray<Said>; readonly tools: ReadonlyArray<string>; readonly purpose?: "summary"; readonly givenTurn?: true }
  /** What the provider reported the last prompt cost, a summarizer's with `purpose: "summary"`. */
  | { readonly _tag: "Usage"; readonly session: string; readonly turn: number; readonly usage: Reported; readonly purpose?: "summary" }
  /** The program took messages off the chat's queue: the next one, or every one that waited. */
  | { readonly _tag: "Taken"; readonly count: number }
  /** What the program told the chat, after the turn it last opened. */
  | { readonly _tag: "Piece"; readonly turn: number; readonly text: string }
  | { readonly _tag: "Reply"; readonly turn: number; readonly text: string }
  | { readonly _tag: "Failed"; readonly turn: number; readonly message: string }
  | { readonly _tag: "Status"; readonly turn: number; readonly text: string }
  /** The program stopped on its own: it ended, or failed. Never sent for a stop the page asked for. */
  | { readonly _tag: "Ended"; readonly reason: string }
  /**
   * A durable lesson's program named the conversation to show (its chat's `resume`), as the program started: the
   * session, and its journal as it was then, a turn closed by `resume` included.
   */
  | { readonly _tag: "Showing"; readonly session: string; readonly journal: ReadonlyArray<StoredEvent> }
  /** A tool asked before it acts (lesson 9): the question waits for the person, under an id `decide` answers it by. */
  | { readonly _tag: "Asking"; readonly id: string; readonly action: string; readonly detail: string }
  /** A question no longer waits: it was answered, or dropped with the turn that asked (Stop, a rebuild, Clear context). */
  | { readonly _tag: "Asked"; readonly id: string }
  /**
   * A session other than the chat's that a turn opened in, as its header says what it is: who owns it, and the
   * session it was created under, if any. Heard once a session, before the first record of its first turn here.
   */
  | { readonly _tag: "Session"; readonly session: string; readonly owner: string; readonly parent?: string }

export type BuildResult =
  | { readonly _tag: "Built" }
  | { readonly _tag: "Refused"; readonly message: string }

type BaseServices = Core | JournalStorage | Sessions

/**
 * Whether the work under way is a summarizer's. The page's own, and private to it: `watchSummarizer` provides it
 * as `true` around `summarize`, and the model watcher reads it as a stream runs, so a model call a summarizer
 * makes is told from the turn's by what it runs in, however many run at once.
 */
const Summarizing = Context.Reference<boolean>("learn/Summarizing", { defaultValue: () => false })

const count = (value: unknown, key: string): Option.Option<number> =>
  typeof value === "object" && value !== null && key in value && typeof (value as Record<string, unknown>)[key] === "number"
    ? Option.some((value as Record<string, number>)[key]!)
    : Option.none()

/** What a stream's finish part says the call cost, when it says. */
const usageOf = (part: unknown): Option.Option<Reported> => {
  if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "finish" || !("usage" in part)) return Option.none()
  const usage = part.usage
  if (typeof usage !== "object" || usage === null) return Option.none()
  const input = "inputTokens" in usage ? usage.inputTokens : undefined
  const output = "outputTokens" in usage ? usage.outputTokens : undefined
  const fields = (name: string, option: Option.Option<number>) => Option.match(option, { onNone: () => ({}), onSome: (value) => ({ [name]: value }) })
  return Option.some({
    ...fields("inputTokens", count(input, "total")),
    ...fields("outputTokens", count(output, "total")),
    ...fields("cachedInputTokens", count(input, "cacheRead")),
  })
}

const saidOf = (raw: Prompt.RawInput): ReadonlyArray<Said> => Prompt.make(raw).content.map(saidOfMessage)

/** The session a turn's start or end is about. */
const sessionOf = (event: { readonly session?: unknown; readonly id?: unknown }): string =>
  typeof event.session === "string" ? event.session : typeof event.id === "string" ? event.id : ""

export class LessonRuntime {
  private model: Option.Option<LoadedModel> = Option.none()
  private program: Option.Option<{ readonly fiber: Fiber.Fiber<unknown, unknown>; readonly scope: Scope.Closeable }> = Option.none()
  private readonly listeners = new Set<(trace: Trace) => void>()
  private session: SessionId
  /** The turn open in each session, by its id: the chat's, and any other a program runs a turn in (a helper's). */
  private readonly openTurns = new Map<string, number>()
  /** The chat's last turn: what the chat's pieces, replies and status lines belong to. */
  private lastTurn = 0
  /**
   * The session memory was last asked about. Only a model call that runs with no `CurrentTurn` is placed by it: a
   * program that reads the model's stream by hand (lessons 1 and 2) asks memory for the context and then calls
   * the model, in one fiber and one session, so the next prompt is that session's. A call made through
   * `modelAnswer` names its own turn, and this is not looked at.
   */
  private asked: string | undefined
  /** The sessions, other than the chat's, whose header the page was told of (`Session`). */
  private readonly announced = new Set<string>()
  private last: Sources = {}
  private building: Promise<unknown> = Promise.resolve()

  /** The questions that wait for the person, by id: each is completed by `decide`, and taken out when it no longer waits. */
  private readonly questions = new Map<string, Deferred.Deferred<Decision>>()
  /** How many questions were ever asked: the next one's id. */
  private questionCount = 0

  /** A durable lesson's store, once its program has built one: what the base's storage hands every call to. */
  private store: Option.Option<Context.Service.Shape<typeof JournalStorage>> = Option.none()

  private constructor(
    private readonly lesson: Lesson,
    private readonly root: Scope.Closeable,
    private readonly base: Context.Context<BaseServices>,
    private readonly queue: Queue.Queue<string>,
    session: SessionId,
    /** A durable lesson's storage, seen through the lesson's prefix. */
    private readonly storage: KeyValueStore,
  ) {
    this.session = session
  }

  /**
   * A runtime for one lesson: its base, its chat's queue and conversation, and the page listening on Core. A
   * durable lesson's base keeps no journal: its storage hands every call to the store the learner's program
   * builds, and no session is created here, since the learner's chat names the one to show.
   */
  static async create(lesson: Lesson, options: RuntimeOptions = {}): Promise<LessonRuntime> {
    const root = await Effect.runPromise(Scope.make())
    const queue = await Effect.runPromise(Queue.bounded<string>(100))
    if (lesson.durable === undefined) {
      const Base = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))
      const base = await Effect.runPromise(Layer.buildWithScope(Base, root))
      const session = await Effect.runPromise(Context.get(base, Sessions).create({ owner: OWNER }))
      const runtime = new LessonRuntime(lesson, root, base, queue, session, memoryStore())
      await Effect.runPromise(runtime.listen().pipe(Effect.provideService(Scope.Scope, root)))
      return runtime
    }
    // The runtime is made before its base, which hands its storage calls to whatever store the runtime holds by then.
    let made: Option.Option<LessonRuntime> = Option.none()
    const through = <A>(use: (store: Context.Service.Shape<typeof JournalStorage>) => Effect.Effect<A, JournalStorageError>) => Effect.suspend(() =>
      Option.match(Option.flatMap(made, (runtime) => runtime.store), {
        onNone: () => Effect.fail(new JournalStorageError({ reason: "Unavailable", message: "no store yet: the program that builds it has not started" })),
        onSome: use,
      }))
    const delegating = JournalStorage.of({
      create: (header) => through((store) => store.create(header)),
      append: (id, expectedSeq, turn, event) => through((store) => store.append(id, expectedSeq, turn, event)),
      read: (id, from) => through((store) => store.read(id, from)),
      list: through((store) => store.list),
    })
    const Base = sessions().pipe(Layer.provideMerge(Layer.succeed(JournalStorage, delegating)), Layer.provideMerge(kernel()))
    const base = await Effect.runPromise(Layer.buildWithScope(Base, root))
    const runtime = new LessonRuntime(lesson, root, base, queue, NO_CONVERSATION, prefixed(options.storage ?? memoryStore(), lesson.durable.prefix))
    made = Option.some(runtime)
    await Effect.runPromise(runtime.listen().pipe(Effect.provideService(Scope.Scope, root)))
    return runtime
  }

  /** Hear what the program does. Returns the unsubscribe. */
  onTrace(listener: (trace: Trace) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(trace: Trace): void {
    this.listeners.forEach((listener) => {
      try { listener(trace) } catch (error) { console.warn("a lesson page listener failed", error) }
    })
  }

  /** The page's listeners on the base's Core: every event, in the order Core hands them over, and which turn is open. */
  private listen(): Effect.Effect<void, never, Scope.Scope> {
    const core = Context.get(this.base, Core)
    const sessionsOf = Context.get(this.base, Sessions)
    const started = (session: string, turn: number) => {
      this.openTurns.set(session, turn)
      if (session === this.session) this.lastTurn = turn
    }
    // A turn opened in a session that is not the chat's and was not named yet: its header is read from the store and
    // the page is told, before the turn's start reaches the page as a record. A header that cannot be read is not
    // named, and the turn goes on: a listener the publisher waits for must not fail.
    const named = (session: string): Effect.Effect<void> => Effect.suspend(() => {
      if (session === this.session || this.announced.has(session)) return Effect.void
      this.announced.add(session)
      // Whatever the read ends with, a failure or a defect of the store, is taken as no header.
      return Effect.map(sessionsOf.list.pipe(Effect.catchCause(() => Effect.succeed([]))), (headers) => {
        const header = headers.find((one) => one.id === session)
        if (header !== undefined) this.emit({ _tag: "Session", session, owner: header.owner, ...(header.parent === undefined ? {} : { parent: header.parent }) })
      })
    })
    const ended = (session: string) => { this.openTurns.delete(session) }
    const heard = (event: KernelEvent) => this.emit({ _tag: "Event", event })
    return Effect.gen(function* () {
      // Waited for, so a prompt sent in a turn finds that turn here.
      yield* core.on(turnStartedEvent, (event) => Effect.andThen(Effect.sync(() => started(sessionOf(event), event.data.turn)), named(sessionOf(event))), { name: "page-turns", wait: true })
      yield* core.on(turnEndedEvent, (event) => Effect.sync(() => ended(sessionOf(event))), { name: "page-turns", wait: true })
      yield* Effect.forkScoped(Stream.runForEach(core.events, (event) => Effect.sync(() => heard(event))), { startImmediately: true })
    })
  }

  /** The model the next build hands the program. */
  setModel(model: LoadedModel): void {
    this.model = Option.some(model)
  }

  /** Whether a turn is open. */
  get busy(): boolean {
    return this.openTurns.has(this.session)
  }

  /** Whether a program runs. */
  get running(): boolean {
    return Option.isSome(this.program)
  }

  /** The conversation the chat shows. */
  get conversation(): SessionId {
    return this.session
  }

  /** What the page gives the learner's code under the hood: the base, the chat and the model, as the names the code uses. */
  private parts(model: LoadedModel): PageParts {
    const base = this.base
    const core = Context.get(base, Core)
    const storage = Context.get(base, JournalStorage)
    const sessionsOf = Context.get(base, Sessions)
    const emit = (trace: Trace) => Effect.sync(() => this.emit(trace))
    /** The conversation the chat shows from here on. */
    const shown = (session: SessionId) => {
      this.session = session
      this.asked = undefined
    }
    const chat = Chat.of({
      session: this.session,
      // One message at a time: a message is taken off the queue only when a turn is ready for it,
      // so what waits stays in the queue, where a rebuild keeps it and Stop drops it.
      messages: Stream.fromEffectRepeat(Effect.tap(Queue.take(this.queue), () => emit({ _tag: "Taken", count: 1 }))),
      // Every message waiting now, taken at once: a turn that runs many steps takes them between steps.
      drain: Effect.tap(Effect.map(Queue.clear(this.queue), (taken) => Array.from(taken)), (taken) => taken.length > 0 ? emit({ _tag: "Taken", count: taken.length }) : Effect.void),
      stream: (piece) => Effect.suspend(() => emit({ _tag: "Piece", turn: this.lastTurn, text: piece })),
      reply: (text) => Effect.suspend(() => emit({ _tag: "Reply", turn: this.lastTurn, text })),
      fail: (error) => Effect.suspend(() => emit({ _tag: "Failed", turn: this.lastTurn, message: textOf(error) })),
      status: (text) => Effect.suspend(() => emit({ _tag: "Status", turn: this.lastTurn, text })),
    })
    /** A question that waits from here on, under a new id. */
    const waiting = (answer: Deferred.Deferred<Decision>): string => {
      const id = `question-${++this.questionCount}`
      this.questions.set(id, answer)
      return id
    }
    const inner = model.model
    // With no turn provided: the session memory was last asked about, else the chat's, and the turn open in it.
    const guessed = () => {
      const session = this.asked ?? this.session
      return { session, turn: this.openTurns.get(session) ?? 0 }
    }
    const watched = LanguageModel.LanguageModel.of({
      ...inner,
      // The prompt is traced when the stream runs, not when it is made: a loop makes the stream first and hands it
      // to `modelAnswer`, which provides the turn only while it reads it.
      streamText: ((options: { readonly prompt: Prompt.RawInput; readonly toolkit?: unknown }) => Stream.unwrap(Effect.gen(function* () {
        const current = yield* Effect.serviceOption(CurrentTurn)
        const summarizing = yield* Summarizing
        const { session, turn } = Option.match(current, { onNone: guessed, onSome: (running) => ({ session: String(running.id), turn: Number(running.turn) }) })
        const kit = options.toolkit
        const tools = typeof kit === "object" && kit !== null && "tools" in kit && typeof kit.tools === "object" && kit.tools !== null ? Object.keys(kit.tools) : []
        const purpose = summarizing ? { purpose: "summary" as const } : {}
        // A stream that runs with a turn was handed to the kernel's `modelAnswer` (or is a summarizer's): the Context
        // tab then names that function, not the lines a loop would write by hand.
        const given = Option.isSome(current) ? { givenTurn: true as const } : {}
        yield* emit({ _tag: "Prompt", session, turn, messages: saidOf(options.prompt), tools, ...purpose, ...given })
        return Reflect.apply(inner.streamText, inner, [options]).pipe(
          Stream.tap((part: unknown) => Option.match(usageOf(part), { onNone: () => Effect.void, onSome: (usage) => emit({ _tag: "Usage", session, turn, usage, ...purpose }) })),
        )
      }))) as typeof inner.streamText,
    })
    return {
      // Each requires what the real one requires, so a line removed from the stack fails as it would for real.
      kernel: () => Layer.succeed(Core, core),
      inProcessJournal: () => Layer.effect(JournalStorage, Effect.gen(function* () { yield* Core; return storage })),
      sessions: () => Layer.effect(Sessions, Effect.gen(function* () { yield* JournalStorage; yield* Core; return sessionsOf })),
      chatOn: () => Layer.effect(Chat, Effect.gen(function* () { yield* Sessions; return chat })),
      model: Layer.succeed(LanguageModel.LanguageModel, watched),
      pane: {},
      // Who a tool asks: the person, through the page. The question is announced and waits for `decide`. However the
      // wait ends (an answer, or the turn dropped by Stop, a rebuild or Clear context), the question is taken back
      // and the page is told, so no question is left on screen that nothing waits for.
      approvalOn: () => Layer.succeed(Approval, Approval.of({
        ask: (request) => Effect.acquireUseRelease(
          Effect.gen(function* () {
            const answer = yield* Deferred.make<Decision>()
            const id = waiting(answer)
            yield* emit({ _tag: "Asking", id, action: request.action, detail: request.detail })
            return { id, answer }
          }),
          ({ answer }) => Deferred.await(answer),
          ({ id }) => Effect.suspend(() => {
            this.questions.delete(id)
            return emit({ _tag: "Asked", id })
          }),
        ),
      })),
      watchMemory: (layer) => Layer.effect(Memory, Effect.map(Effect.gen(function* () { return yield* Memory }), (memory) => Memory.of({
        context: (session) => Effect.tap(memory.context(session), (messages) =>
          Effect.flatMap(Effect.orElseSucceed(session.journal, () => []), (journal) => {
            this.asked = session.id
            return emit({ _tag: "Context", session: session.id, turn: session.turn, upTo: journal.at(-1)?.seq ?? 0, messages: messages.map(saidOfMessage) })
          })),
      }))).pipe(Layer.provide(layer)),
      // A model call made inside `summarize` is the summarizer's: it runs with `Summarizing` set, which the model
      // watcher reads, so the lesson's page counts it apart from the turn's.
      watchSummarizer: (layer) => Layer.effect(Summarizer, Effect.map(Effect.gen(function* () { return yield* Summarizer }), (summarizer) => Summarizer.of({
        summarize: (input) => summarizer.summarize(input).pipe(Effect.provideService(Summarizing, true)),
      }))).pipe(Layer.provide(layer)),
      // The learner's store is built, and is what the base's storage hands every call to from here on.
      storeOn: (layer) => Layer.effect(JournalStorage, Effect.map(Effect.gen(function* () { return yield* JournalStorage }), (store) => {
        this.store = Option.some(store)
        return storage
      })).pipe(Layer.provide(layer)),
      storage: this.storage,
      // The learner's `resume` names the conversation; its journal is read before the chat is handed over, so the
      // page draws what is stored before the program takes a message.
      chatWith: (resume) => Layer.effect(Chat, Effect.gen(function* () {
        yield* Sessions
        const session = yield* resume.pipe(Effect.provideService(Sessions, sessionsOf))
        const journal = yield* Effect.mapError(sessionsOf.read(session), (error) => ({ message: `the conversation \`resume\` gave cannot be read: ${error.message}` }))
        shown(session)
        yield* emit({ _tag: "Showing", session, journal: journal.events })
        return Chat.of({ ...chat, session })
      })),
    }
  }

  private async stopProgram(): Promise<void> {
    const program = this.program
    this.program = Option.none()
    if (Option.isNone(program)) return
    await Effect.runPromise(Fiber.interrupt(program.value.fiber))
    await Effect.runPromise(Scope.close(program.value.scope, Exit.void))
  }

  /** Builds run one at a time, in the order asked: a build that lands while another runs waits for it. */
  start(sources: Sources): Promise<BuildResult> {
    const next = this.building.then(() => this.startNow(sources))
    this.building = next.then(() => undefined, () => undefined)
    return next
  }

  private async startNow(sources: Sources): Promise<BuildResult> {
    this.last = sources
    await this.stopProgram()
    if (Option.isNone(this.model)) return { _tag: "Refused", message: "Pick a model first." }
    const evaluated = this.lesson.evaluate(sources, this.parts(this.model.value))
    if (evaluated._tag === "Failure") return { _tag: "Refused", message: evaluated.failure }
    const main = evaluated.success
    const scope = await Effect.runPromise(Scope.fork(this.root))
    const fiber = await Effect.runPromise(Effect.forkIn(main.pipe(
      Effect.onExit((exit) => Effect.sync(() => {
        // A stop the page asked for says nothing; an end of the program's own is said, in words.
        if (Exit.isSuccess(exit)) this.emit({ _tag: "Ended", reason: "your program ended: it stopped taking messages." })
        else if (!Cause.hasInterruptsOnly(exit.cause)) this.emit({ _tag: "Ended", reason: `your program stopped: ${buildFailure(exit.cause)}` })
      })),
    ), scope, { startImmediately: true }))
    this.program = Option.some({ fiber, scope })
    return { _tag: "Built" }
  }

  /** Send a message: it waits in the chat's queue until the program takes it. */
  send(text: string): void {
    Queue.offerUnsafe(this.queue, text)
  }

  /**
   * Answer a question that waits (`Asking`): the tool that asked goes on, or is refused. A question is answered
   * once: an id nothing waits under, unknown or already answered, does nothing.
   */
  decide(id: string, decision: Decision): void {
    const question = this.questions.get(id)
    if (question === undefined) return
    this.questions.delete(id)
    Effect.runSync(Deferred.succeed(question, decision))
  }

  /** Stop: the messages still waiting are dropped, the model is told to stop, and the program starts again over the same code. Returns the dropped messages. */
  async stop(): Promise<{ readonly dropped: ReadonlyArray<string>; readonly result: BuildResult }> {
    const dropped = Array.from(await Effect.runPromise(Queue.clear(this.queue)))
    if (Option.isSome(this.model)) this.model.value.interrupt()
    return { dropped, result: await this.start(this.last) }
  }

  /**
   * A new, empty conversation in the same base, and the program started again. The old one stays in the journal
   * store. In a durable lesson the program's chat finds the new session as the last one, and shows it.
   */
  async clear(): Promise<BuildResult> {
    await Effect.runPromise(Queue.clear(this.queue))
    // The program is stopped first: a turn it has open ends before the new conversation is the one shown.
    await this.stopProgram()
    const created = await Effect.runPromise(Effect.result(Context.get(this.base, Sessions).create({ owner: OWNER })))
    if (created._tag === "Failure") return { _tag: "Refused", message: `a new conversation could not be created: ${created.failure.message}` }
    if (this.lesson.durable === undefined) this.session = created.success
    this.asked = undefined
    return this.start(this.last)
  }

  /** The conversation's journal, as stored; none before a durable lesson's program has named a conversation. */
  async journal(): Promise<ReadonlyArray<StoredEvent>> {
    if (this.session === NO_CONVERSATION) return []
    const journal = await Effect.runPromise(Context.get(this.base, Sessions).read(this.session))
    return journal.events
  }

  /** Every session the store holds, by creation. */
  async list(): Promise<ReadonlyArray<{ readonly id: string; readonly owner: string; readonly parent?: string; readonly createdAt: number; readonly format: number }>> {
    return Effect.runPromise(Effect.orElseSucceed(Context.get(this.base, Sessions).list, () => []))
  }

  /** Run one of the lesson's kits over the learner's code: each check, passed or what it found. */
  async runKit(id: string, sources: Sources): Promise<Result.Result<ReadonlyArray<KitResult>, string>> {
    const kit = this.lesson.kits?.[id]
    if (kit === undefined) return Result.fail(`this lesson has no kit named ${id}`)
    const checks = kit(sources, memoryStore)
    if (Result.isFailure(checks)) return Result.fail(checks.failure)
    const ran = await Effect.runPromise(Effect.forEach(checks.success, (check) => Effect.exit(Effect.timeout(check.run, "5 seconds")).pipe(
      Effect.map((exit): KitResult => Exit.isSuccess(exit)
        ? { id: check.id, name: check.name, passed: true, message: "" }
        : { id: check.id, name: check.name, passed: false, message: Option.match(Cause.findErrorOption(exit.cause), { onNone: () => buildFailure(exit.cause), onSome: textOf }) }),
    ), { concurrency: 1 }))
    return Result.succeed(ran)
  }

  async dispose(): Promise<void> {
    await this.stopProgram()
    await Effect.runPromise(Scope.close(this.root, Exit.void))
  }
}
