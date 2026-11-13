// The lesson runtime: the kernel, running in the page, and the learner's
// program over it. The base (events, the journal, sessions) and the chat's
// queue and conversation are built once in a root scope; each build runs the
// learner's program as one long-running fiber over them, its modules handed
// stand-ins for the base layers it names, so the conversation outlives
// every rebuild. What happens is traced for the page: every event on Core,
// what memory built for each turn, every prompt the model received, and
// what the program told the chat.
import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Queue, Scope, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { Core, JournalStorage, kernel, Sessions, turnEndedEvent, turnStartedEvent } from "@xandreed/core/kernel"
import type { KernelEvent, SessionId, StoredEvent } from "@xandreed/core/kernel"
import { inProcessJournal, Memory, sessions } from "@xandreed/sdk/kernel"
import { buildFailure, textOf } from "./evaluate.ts"
import type { Lesson, PageParts, Sources } from "./lesson.ts"
import type { LoadedModel } from "./models/types.ts"
import { Chat } from "./page-chat.ts"

const OWNER = "learner"

/** A message as the page shows it: who it is from, and its text. */
export interface Said {
  readonly role: string
  readonly text: string
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
  /** What memory built for a turn: the messages after the system text, from the journal as it was up to record `upTo`. */
  | { readonly _tag: "Context"; readonly turn: number; readonly upTo: number; readonly messages: ReadonlyArray<Said> }
  /** A prompt the model received, in the turn open when it was sent. */
  | { readonly _tag: "Prompt"; readonly turn: number; readonly messages: ReadonlyArray<Said> }
  /** What the provider reported the last prompt cost. */
  | { readonly _tag: "Usage"; readonly turn: number; readonly usage: Reported }
  /** What the program told the chat, after the turn it last opened. */
  | { readonly _tag: "Piece"; readonly turn: number; readonly text: string }
  | { readonly _tag: "Reply"; readonly turn: number; readonly text: string }
  | { readonly _tag: "Failed"; readonly turn: number; readonly message: string }
  | { readonly _tag: "Status"; readonly turn: number; readonly text: string }
  /** The program stopped on its own: it ended, or failed. Never sent for a stop the page asked for. */
  | { readonly _tag: "Ended"; readonly reason: string }

export type BuildResult =
  | { readonly _tag: "Built" }
  | { readonly _tag: "Refused"; readonly message: string }

type BaseServices = Core | JournalStorage | Sessions

/** A prompt message's text, decoded or encoded: its string, or the text of its parts. */
const textOfMessage = (message: { readonly content: string | ReadonlyArray<object> }): string =>
  typeof message.content === "string" ? message.content
    : message.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("")

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

const saidOf = (raw: Prompt.RawInput): ReadonlyArray<Said> =>
  Prompt.make(raw).content.map((message) => ({ role: message.role, text: textOfMessage(message) }))

export class LessonRuntime {
  private model: Option.Option<LoadedModel> = Option.none()
  private program: Option.Option<{ readonly fiber: Fiber.Fiber<unknown, unknown>; readonly scope: Scope.Closeable }> = Option.none()
  private readonly listeners = new Set<(trace: Trace) => void>()
  private session: SessionId
  private openTurn = 0
  private lastTurn = 0
  private last: Sources = {}
  private building: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly lesson: Lesson,
    private readonly root: Scope.Closeable,
    private readonly base: Context.Context<BaseServices>,
    private readonly queue: Queue.Queue<string>,
    session: SessionId,
  ) {
    this.session = session
  }

  /** A runtime for one lesson: its base, its chat's queue and conversation, and the page listening on Core. */
  static async create(lesson: Lesson): Promise<LessonRuntime> {
    const root = await Effect.runPromise(Scope.make())
    const Base = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))
    const base = await Effect.runPromise(Layer.buildWithScope(Base, root))
    const queue = await Effect.runPromise(Queue.bounded<string>(100))
    const session = await Effect.runPromise(Context.get(base, Sessions).create({ owner: OWNER }))
    const runtime = new LessonRuntime(lesson, root, base, queue, session)
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
    const started = (turn: number) => { this.openTurn = turn; this.lastTurn = turn }
    const ended = () => { this.openTurn = 0 }
    const heard = (event: KernelEvent) => this.emit({ _tag: "Event", event })
    return Effect.gen(function* () {
      // Waited for, so a prompt sent in a turn finds that turn here.
      yield* core.on(turnStartedEvent, (event) => Effect.sync(() => started(event.data.turn)), { name: "page-turns", wait: true })
      yield* core.on(turnEndedEvent, () => Effect.sync(ended), { name: "page-turns", wait: true })
      yield* Effect.forkScoped(Stream.runForEach(core.events, (event) => Effect.sync(() => heard(event))), { startImmediately: true })
    })
  }

  /** The model the next build hands the program. */
  setModel(model: LoadedModel): void {
    this.model = Option.some(model)
  }

  /** Whether a turn is open. */
  get busy(): boolean {
    return this.openTurn > 0
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
    const chat = Chat.of({
      session: this.session,
      // One message at a time: a message is taken off the queue only when a turn is ready for it,
      // so what waits stays in the queue, where a rebuild keeps it and Stop drops it.
      messages: Stream.fromEffectRepeat(Queue.take(this.queue)),
      stream: (piece) => Effect.suspend(() => emit({ _tag: "Piece", turn: this.lastTurn, text: piece })),
      reply: (text) => Effect.suspend(() => emit({ _tag: "Reply", turn: this.lastTurn, text })),
      fail: (error) => Effect.suspend(() => emit({ _tag: "Failed", turn: this.lastTurn, message: textOf(error) })),
      status: (text) => Effect.suspend(() => emit({ _tag: "Status", turn: this.lastTurn, text })),
    })
    const inner = model.model
    const turnOf = () => this.openTurn
    const watched = LanguageModel.LanguageModel.of({
      ...inner,
      streamText: ((options: { readonly prompt: Prompt.RawInput }) => {
        const turn = turnOf()
        this.emit({ _tag: "Prompt", turn, messages: saidOf(options.prompt) })
        return Reflect.apply(inner.streamText, inner, [options]).pipe(
          Stream.tap((part: unknown) => Option.match(usageOf(part), { onNone: () => Effect.void, onSome: (usage) => emit({ _tag: "Usage", turn, usage }) })),
        )
      }) as typeof inner.streamText,
    })
    return {
      // Each requires what the real one requires, so a line removed from the stack fails as it would for real.
      kernel: () => Layer.succeed(Core, core),
      inProcessJournal: () => Layer.effect(JournalStorage, Effect.gen(function* () { yield* Core; return storage })),
      sessions: () => Layer.effect(Sessions, Effect.gen(function* () { yield* JournalStorage; yield* Core; return sessionsOf })),
      chatOn: () => Layer.effect(Chat, Effect.gen(function* () { yield* Sessions; return chat })),
      model: Layer.succeed(LanguageModel.LanguageModel, watched),
      pane: {},
      watchMemory: (layer) => Layer.effect(Memory, Effect.map(Effect.gen(function* () { return yield* Memory }), (memory) => Memory.of({
        context: (session) => Effect.tap(memory.context(session), (messages) =>
          Effect.flatMap(Effect.orElseSucceed(session.journal, () => []), (journal) =>
            emit({ _tag: "Context", turn: session.turn, upTo: journal.at(-1)?.seq ?? 0, messages: messages.map((message) => ({ role: message.role, text: textOfMessage(message) })) }))),
      }))).pipe(Layer.provide(layer)),
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

  /** Stop: the messages still waiting are dropped, the model is told to stop, and the program starts again over the same code. Returns the dropped messages. */
  async stop(): Promise<{ readonly dropped: ReadonlyArray<string>; readonly result: BuildResult }> {
    const dropped = Array.from(await Effect.runPromise(Queue.clear(this.queue)))
    if (Option.isSome(this.model)) this.model.value.interrupt()
    return { dropped, result: await this.start(this.last) }
  }

  /** A new, empty conversation in the same base, and the program started again. The old one stays in the journal store. */
  async clear(): Promise<BuildResult> {
    await Effect.runPromise(Queue.clear(this.queue))
    this.session = await Effect.runPromise(Context.get(this.base, Sessions).create({ owner: OWNER }))
    return this.start(this.last)
  }

  /** The conversation's journal, as stored. */
  async journal(): Promise<ReadonlyArray<StoredEvent>> {
    const journal = await Effect.runPromise(Context.get(this.base, Sessions).read(this.session))
    return journal.events
  }

  async dispose(): Promise<void> {
    await this.stopProgram()
    await Effect.runPromise(Scope.close(this.root, Exit.void))
  }
}
