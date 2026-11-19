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
// with its header before that turn's first record is heard. A lesson with a
// workspace (lesson 16) has one `Files`, built once in the root scope from
// its seed: the program is given it as a value, and the page's file pane
// reads and writes the same one. The chat's queue is one queue of what comes
// into the conversation: the person's messages and, in lesson 17, the reports
// of background tasks, in the order they came. A turn's `drain` takes the
// messages and leaves the reports, each of which gets a turn of its own; a
// report still waiting when the program stops is dropped. A lesson whose
// program keeps a memory with a curator (lesson 18) is given the curator's
// model (`curatorModel`: the model picked when it is Echo or the gateway's,
// else a page Echo) and has its curator watched (`watchCurator`): the
// curator's model calls are traced as the curator's, on the knowledge
// session and the turn that stored their source, never as the chat's.
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Queue, Result, Schema, Scope, Stream } from "effect"
import { AiError, LanguageModel, Prompt, Response } from "effect/ai"
import { Core, dataOf, JournalStorage, JournalStorageError, kernel, SessionId, Sessions, turnEndedEvent, turnStartedEvent } from "@xandreed/core/kernel"
import type { KernelEvent, SessionHeader, StoredEvent, TurnNumber } from "@xandreed/core/kernel"
import {
  Approval, curatedEvent, curationFailedEvent, Curator, CurrentTurn, Files, inMemoryFiles, inProcessJournal, knowledgeSession, Memory, sessions, sourceEvent, Summarizer, TaskReports,
} from "@xandreed/sdk/kernel"
import type { Decision, KeyValueStore, TaskReport } from "@xandreed/sdk/kernel"
import { CHAT_OWNER, chatsOf } from "./chats.ts"
import type { ChatEntry } from "./chats.ts"
import { buildFailure, textOf } from "./evaluate.ts"
import type { Lesson, MadeFailure, PageParts, Sources } from "./lesson.ts"
import { loadEcho } from "./models/mock.ts"
import type { LoadedModel } from "./models/types.ts"
import { Chat } from "./page-chat.ts"
import type { ChatInput } from "./page-chat.ts"
import { saidOfMessage } from "./said.ts"

const OWNER = CHAT_OWNER

/** What a durable lesson's runtime shows before its program has named a conversation: no session has this id. */
export const NO_CONVERSATION = SessionId.make("no-conversation-yet")

/** How a runtime is made. */
export interface RuntimeOptions {
  /** A durable lesson's storage: the browser's `localStorage` on the page, a value of the test's own in a test. */
  readonly storage?: KeyValueStore
  /**
   * What a durable lesson keeps for this tab alone (lesson 15): the browser's `sessionStorage` on the page. The
   * chat picked is kept there, so a reload shows the same chat and a new tab the latest.
   */
  readonly tab?: KeyValueStore
}

/** Where a durable lesson keeps the chat picked, in the tab's storage, under the lesson's prefix. */
export const CHOSEN_KEY = "chosen"

/** What `branch` says while no program runs: the page's base hands every call to the store the program builds. */
export const NOT_RUNNING = "your program is not running, so no store is open to make a branch in. Fix it, then press Rebuild."

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
  /** What the check found, when it failed; what it said, when it passed and said something (lesson 12's live check); else empty. */
  readonly message: string
}

/** How long one check of a kit may run, for a kit that states no limit of its own. */
export const KIT_TIMEOUT = "5 seconds"

/** What `runKit` says of a kit that runs alone, asked for while a turn runs in the chat. */
export const TURN_RUNNING = "a turn is running in the chat. Run this when it has answered."

/** What the page says of a run that takes turns with the chat, asked for while the curator keeps a turn (lesson 18). */
export const CURATING = "the curator is keeping the last turn. Run this when it is done."

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
   * summarizer's (`purpose: "summary"`) was sent while memory compacted, not by the turn's loop. `model` names the
   * model it was sent to, as its answers name it, and `picked` the model picked when it was sent: they differ for
   * the spare's prompts (lesson 14).
   */
  | { readonly _tag: "Prompt"; readonly session: string; readonly turn: number; readonly messages: ReadonlyArray<Said>; readonly tools: ReadonlyArray<string>; readonly model: string; readonly picked: string; readonly purpose?: Purpose; readonly givenTurn?: true }
  /**
   * The stream of the session's turn's last prompt failed, in these words: that attempt has no answer (lesson 14,
   * a call under a plan). Said by the stream itself, so it always follows its own prompt and comes before the
   * next. A stream that was stopped is not said to have failed. A summarizer's (`purpose: "summary"`) is no try of
   * the turn's model call.
   */
  | { readonly _tag: "PromptFailed"; readonly session: string; readonly turn: number; readonly reason: string; readonly purpose?: Purpose }
  /** What the provider reported the last prompt cost, a summarizer's with `purpose: "summary"`, a curator's with `purpose: "curation"`. */
  | { readonly _tag: "Usage"; readonly session: string; readonly turn: number; readonly usage: Reported; readonly purpose?: Purpose }
  /**
   * The curator answered (lesson 18): its reply's text, for the job named, filed on the knowledge session under the
   * turn that stored the job's source. The kernel reads and checks it; nothing of it is stored.
   */
  | { readonly _tag: "CuratorAnswered"; readonly session: string; readonly turn: number; readonly source: string; readonly attempt: number; readonly job: "extract" | "review"; readonly reply: string }
  /**
   * A curation was cut short as the program stopped (Stop, a rebuild, Clear context; lesson 18): its source, filed
   * where its curator's calls are. Its source stays pending, for the next program's turn to take up.
   */
  | { readonly _tag: "CurationCut"; readonly session: string; readonly turn: number; readonly source: string }
  /** The program took messages off the chat's queue: the next one, or every one that waited. A report taken says nothing. */
  | { readonly _tag: "Taken"; readonly count: number }
  /** A background task's report was put in the chat's queue, behind what came before it (lesson 17): it waits for a turn of its own. */
  | { readonly _tag: "Reported"; readonly task: string; readonly session: string }
  /**
   * The reports still waiting in the chat's queue were dropped as the program stopped (Stop, a rebuild, Clear
   * context): the tasks' sessions. Task ids start again with the program that comes next.
   */
  | { readonly _tag: "ReportsDropped"; readonly sessions: ReadonlyArray<string> }
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
  | {
    readonly _tag: "Showing"; readonly session: string; readonly journal: ReadonlyArray<StoredEvent>
    /** The session is a branch (lesson 15): the chat it was cut from, the place of its last copied record, and that chat's label in the row. */
    readonly branch?: { readonly of: string; readonly through: number; readonly label: string }
    /** This page showed the session before, and shows it again after another (lesson 15): what it saw of its turns is gone. */
    readonly again?: true
  }
  /** A tool asked before it acts (lesson 9): the question waits for the person, under an id `decide` answers it by. */
  | { readonly _tag: "Asking"; readonly id: string; readonly action: string; readonly detail: string }
  /** A question no longer waits: it was answered, or dropped with the turn that asked (Stop, a rebuild, Clear context). */
  | { readonly _tag: "Asked"; readonly id: string }
  /**
   * A session other than the chat's that a turn opened in, as its header says what it is: who owns it, and the
   * session it was created under, if any. Heard once a session, before the first record of its first turn here.
   */
  | { readonly _tag: "Session"; readonly session: string; readonly owner: string; readonly parent?: string }

/**
 * Whose model call a prompt is, when it is not the turn's loop's: a summarizer's, made while memory compacted
 * (lesson 5), or a curator's, made while a turn was kept (lesson 18).
 */
export type Purpose = "summary" | "curation"

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

/**
 * The curator's job under way, if any (lesson 18): the page's own, as `Summarizing` is. `watchCurator` provides it
 * around `curate`, with the knowledge session and the turn that stored the job's source, and the model watcher files
 * a call made in it there, as the curator's.
 */
const Curating = Context.Reference<Option.Option<{ readonly session: string; readonly turn: number }>>("learn/Curating", { defaultValue: () => Option.none() })

/** Whether a model can curate (lesson 18): Echo by its rules, a gateway's model by reading the prompt. A model that runs in the browser cannot read the curation prompt in one request. */
const curatesItself = (model: LoadedModel): boolean => model.choice.kind === "echo" || model.choice.kind === "gateway"

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

/** The name the page's spare answers under (lesson 14): a second Echo, never failing. */
export const SPARE = "echo-spare"

/**
 * What a failure failures.ts made says (lesson 14): that the page made it, and whether it said the call is worth
 * another try. A learner on a real model reads these words, so they never speak for the model.
 */
export const madeFailureWords = (failure: MadeFailure): string => {
  const pieces = failure.pieces === undefined ? "" : ` after ${failure.pieces.length} piece${failure.pieces.length === 1 ? "" : "s"}`
  return `failures.ts made this call fail${pieces}, and ${failure.retryable === true ? "said" : "did not say"} it is worth another try`
}

/**
 * A call failures.ts made fail, as a model's stream fails: an `AiError` of the model named, a provider's own error
 * when it is worth another try and an unknown error when not, as the kernel's scripted model fails. With pieces the
 * answer starts and shows them first: they are the page's, not the model's, which is never called.
 */
const madeFailure = (model: string, failure: MadeFailure) => {
  const description = madeFailureWords(failure)
  const error = AiError.make({
    module: model,
    method: "streamText",
    reason: failure.retryable === true ? new AiError.InternalProviderError({ description }) : new AiError.UnknownError({ description }),
  })
  const shown = failure.pieces === undefined ? [] : [
    Response.makePart("text-start", { id: "failures" }),
    ...failure.pieces.map((delta) => Response.makePart("text-delta", { id: "failures", delta })),
  ]
  return Stream.concat(Stream.fromIterable(shown), Stream.fail(error))
}

/** What ended a stream that failed, in words: its failure's own, or the defect's. */
const failureWords = (cause: Cause.Cause<unknown>): string =>
  Option.match(Cause.findErrorOption(cause), { onSome: textOf, onNone: () => Cause.prettyErrors(cause)[0]?.message ?? "the stream failed" })

/** Everything waiting in a queue now, taken in one step that does not wait: nothing is offered in between. */
const takeEverything = <A>(queue: Queue.Queue<A>): Array<A> => {
  const taken: Array<A> = []
  for (let next = Queue.takeUnsafe(queue); next !== undefined; next = Queue.takeUnsafe(queue)) {
    if (Exit.isSuccess(next)) taken.push(next.value)
  }
  return taken
}

/**
 * The chat's queue, split in one step that does not wait: what `keep` holds goes back in its order, and the rest is
 * returned. A send or a report that comes meanwhile cannot land between the two, so the queue's order stays.
 */
const takeExcept = (queue: Queue.Queue<ChatInput>, keep: (input: ChatInput) => boolean): ReadonlyArray<ChatInput> => {
  const all = takeEverything(queue)
  Queue.offerAllUnsafe(queue, all.filter(keep))
  return all.filter((input) => !keep(input))
}

const isReport = (input: ChatInput): boolean => input._tag === "Report"
const textsOf = (inputs: ReadonlyArray<ChatInput>): ReadonlyArray<string> => inputs.flatMap((input) => (input._tag === "Message" ? [input.text] : []))

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

  /** Whether a kit that runs alone (`LessonKit.alone`), or another run that takes turns with the chat (`runAlone`), is running now. */
  private kitAlone = false
  /** The run `runAlone` started (lesson 13's evals), while it runs: what `stopAlone` interrupts. */
  private aloneRun: Option.Option<Fiber.Fiber<unknown, unknown>> = Option.none()

  /** The page's spare (lesson 14): a second Echo, built once, which a plan's second step provides. */
  private readonly spare: LoadedModel = loadEcho(undefined, SPARE)

  /**
   * The curator's Echo (lesson 18): what curates while a model that runs in the browser is picked. A local model
   * cannot read the curation prompt (about 2,300 tokens) in one request, so Echo curates by rule in its place.
   */
  private readonly curatorEcho: LoadedModel = loadEcho()

  /**
   * The sources the program's curator is keeping now (lesson 18): from the record that stored a source, or the
   * curator's first call for one taken up again, until the record that says it was curated or failed. Emptied when
   * the program stops: a curation cut short stores nothing more, and its source stays pending.
   */
  private readonly curatingSources = new Set<string>()
  /** Where the curator's calls for each source being kept are filed: what a curation cut short is said under. */
  private readonly curatingPlaces = new Map<string, { readonly session: string; readonly turn: number }>()

  /** A durable lesson's store, once its program has built one: what the base's storage hands every call to. */
  private store: Option.Option<Context.Service.Shape<typeof JournalStorage>> = Option.none()

  /** The chat the page asks to show (lesson 15), kept in the tab's storage: see `PageParts.chosen`. */
  private chosenChat: Option.Option<SessionId>
  /** The sessions this page has shown: one shown again after another says so (`Showing.again`). */
  private readonly shownBefore = new Set<string>()

  /** The page's workspace (lesson 16), built once with the runtime: none for a lesson that declares none. */
  private files: Option.Option<Context.Service.Shape<typeof Files>> = Option.none()

  private constructor(
    private readonly lesson: Lesson,
    private readonly root: Scope.Closeable,
    private readonly base: Context.Context<BaseServices>,
    private readonly queue: Queue.Queue<ChatInput>,
    session: SessionId,
    /** A durable lesson's storage, seen through the lesson's prefix. */
    private readonly storage: KeyValueStore,
    /** What a durable lesson keeps for this tab alone, seen through the lesson's prefix. */
    private readonly tab: KeyValueStore,
  ) {
    this.session = session
    this.chosenChat = Schema.decodeUnknownOption(SessionId)(tab.getItem(CHOSEN_KEY))
  }

  /**
   * A runtime for one lesson: its base, its chat's queue and conversation, and the page listening on Core. A
   * durable lesson's base keeps no journal: its storage hands every call to the store the learner's program
   * builds, and no session is created here, since the learner's chat names the one to show.
   */
  static async create(lesson: Lesson, options: RuntimeOptions = {}): Promise<LessonRuntime> {
    const root = await Effect.runPromise(Scope.make())
    const queue = await Effect.runPromise(Queue.bounded<ChatInput>(100))
    if (lesson.durable === undefined) {
      const Base = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))
      const base = await Effect.runPromise(Layer.buildWithScope(Base, root))
      const session = await Effect.runPromise(Context.get(base, Sessions).create({ owner: OWNER }))
      const runtime = new LessonRuntime(lesson, root, base, queue, session, memoryStore(), memoryStore())
      await runtime.openWorkspace()
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
      fork: (header) => through((store) => store.fork(header)),
    })
    const Base = sessions().pipe(Layer.provideMerge(Layer.succeed(JournalStorage, delegating)), Layer.provideMerge(kernel()))
    const base = await Effect.runPromise(Layer.buildWithScope(Base, root))
    const { prefix } = lesson.durable
    const runtime = new LessonRuntime(lesson, root, base, queue, NO_CONVERSATION, prefixed(options.storage ?? memoryStore(), prefix), prefixed(options.tab ?? memoryStore(), prefix))
    made = Option.some(runtime)
    await runtime.openWorkspace()
    await Effect.runPromise(runtime.listen().pipe(Effect.provideService(Scope.Scope, root)))
    return runtime
  }

  /** The lesson's workspace, in memory from its seed, built once in the root scope: it lasts as long as the runtime. */
  private async openWorkspace(): Promise<void> {
    const seed = this.lesson.workspace?.seed
    if (seed === undefined) return
    const built = await Effect.runPromise(Layer.buildWithScope(inMemoryFiles(seed), this.root))
    this.files = Option.some(Context.get(built, Files))
  }

  /**
   * The page's workspace (lesson 16), as it is: the one the program is given, never what the learner's workspace.ts
   * wraps around it. The file pane reads and writes it, since a person is not the agent. None for a lesson without one.
   */
  get workspace(): Option.Option<Context.Service.Shape<typeof Files>> {
    return this.files
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
    const curating = this.curatingSources
    return Effect.gen(function* () {
      // Waited for, so a prompt sent in a turn finds that turn here.
      yield* core.on(turnStartedEvent, (event) => Effect.andThen(Effect.sync(() => started(sessionOf(event), event.data.turn)), named(sessionOf(event))), { name: "page-turns", wait: true })
      yield* core.on(turnEndedEvent, (event) => Effect.sync(() => ended(sessionOf(event))), { name: "page-turns", wait: true })
      // Lesson 18: a source stored starts a curation, and the record that it was curated or failed ends it.
      yield* core.on(sourceEvent, (event) => Effect.sync(() => { curating.add(event.data.id) }), { name: "page-curations", wait: true })
      yield* core.on(curatedEvent, (event) => Effect.sync(() => { curating.delete(event.data.source) }), { name: "page-curations", wait: true })
      yield* core.on(curationFailedEvent, (event) => Effect.sync(() => { curating.delete(event.data.source) }), { name: "page-curations", wait: true })
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

  /** Whether a kit that runs alone is running: the chat takes no message until it is done. */
  get checking(): boolean {
    return this.kitAlone
  }

  /**
   * Whether the program's curator is keeping a turn (lesson 18): the program takes the next message once it is done.
   * A run that takes turns with the chat (Load the world, a kit that runs alone) is refused meanwhile, so no two
   * writers hit the knowledge session at once.
   */
  get curating(): boolean {
    return this.curatingSources.size > 0
  }

  /** Why a run that takes turns with the chat cannot start now, if it cannot: a turn runs, the curator keeps one, or another such run is under way. */
  private notAlone(): Option.Option<string> {
    return this.busy ? Option.some(TURN_RUNNING) : this.curating ? Option.some(CURATING) : this.checking ? Option.some("it is running already.") : Option.none()
  }

  /** Whether a program runs. */
  get running(): boolean {
    return Option.isSome(this.program)
  }

  /** The conversation the chat shows. */
  get conversation(): SessionId {
    return this.session
  }

  /** The chat the page asks to show (lesson 15): see `PageParts.chosen`. */
  get chosen(): Option.Option<SessionId> {
    return this.chosenChat
  }

  /** The chat the page asks to show from here on, kept in the tab's storage; none removes it. */
  private setChosen(chat: Option.Option<SessionId>): void {
    this.chosenChat = chat
    Option.match(chat, { onNone: () => this.tab.removeItem(CHOSEN_KEY), onSome: (id) => this.tab.setItem(CHOSEN_KEY, id) })
  }

  /**
   * The row of chats (lesson 15), from the store's headers: the learner's own, labelled (`chatsOf`). A branch's turn
   * is read from its own record at the place it was cut. A store that cannot list gives an empty row.
   */
  private readonly chatsNow: Effect.Effect<ReadonlyArray<ChatEntry>> = Effect.suspend(() => {
    const storage = Context.get(this.base, JournalStorage)
    const turnOf = (header: SessionHeader) => Option.match(Option.fromNullishOr(header.branch), {
      onNone: () => Effect.succeed([]),
      onSome: ({ through }) => Effect.map(
        Effect.orElseSucceed(storage.read(header.id, through), () => ({ events: [] })),
        ({ events }) => Option.match(Option.fromNullishOr(events[0]), { onNone: () => [], onSome: (event) => [[String(header.id), Number(event.turn)] as const] }),
      ),
    })
    return Effect.flatMap(Effect.orElseSucceed(Context.get(this.base, Sessions).list, () => []), (headers) =>
      Effect.map(Effect.forEach(headers, turnOf, { concurrency: 1 }), (turns) => chatsOf(headers, new Map(turns.flat()))))
  })

  /** The row of chats (lesson 15): the learner's own conversations and their branches, labelled, by creation. */
  async chats(): Promise<ReadonlyArray<ChatEntry>> {
    return Effect.runPromise(this.chatsNow)
  }

  /** What the page gives the learner's code under the hood: the base, the chat and the model, as the names the code uses. */
  private parts(model: LoadedModel): PageParts {
    const base = this.base
    const core = Context.get(base, Core)
    const storage = Context.get(base, JournalStorage)
    const sessionsOf = Context.get(base, Sessions)
    const emit = (trace: Trace) => Effect.sync(() => this.emit(trace))
    /** The conversation the chat shows from here on, and whether this page showed it before another. */
    const shown = (session: SessionId): boolean => {
      const again = session !== this.session && this.shownBefore.has(session)
      this.shownBefore.add(session)
      this.session = session
      this.asked = undefined
      return again
    }
    const chatsNow = this.chatsNow
    const queue = this.queue
    // One input at a time: it is taken off the queue only when a turn is ready for it, so what waits stays in the
    // queue, where a rebuild keeps a message and Stop drops it. Only a message taken is said: a report has no row
    // waiting in the chat.
    const inputs = Stream.fromEffectRepeat(Effect.tap(Queue.take(queue), (input) => input._tag === "Message" ? emit({ _tag: "Taken", count: 1 }) : Effect.void))
    const chat = Chat.of({
      session: this.session,
      // The messages alone: a program that reads only these (every lesson but 17) passes a report over.
      messages: Stream.filterMap(inputs, (input) => input._tag === "Message" ? Result.succeed(input.text) : Result.failVoid),
      inputs,
      // Every message waiting now, taken at once: a turn that runs many steps takes them between steps. A report
      // waiting stays where it is, for a turn of its own (lesson 17).
      drain: Effect.suspend(() => {
        const taken = textsOf(takeExcept(queue, isReport))
        return Effect.as(taken.length > 0 ? emit({ _tag: "Taken", count: taken.length }) : Effect.void, taken)
      }),
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
    // With no turn provided: the session memory was last asked about, else the chat's, and the turn open in it.
    const guessed = () => {
      const session = this.asked ?? this.session
      return { session, turn: this.openTurns.get(session) ?? 0 }
    }
    const picked = model.choice.id
    const curatingSources = this.curatingSources
    const curatingPlaces = this.curatingPlaces
    /**
     * Where the page files a curator's calls for a source (lesson 18): the knowledge session, and the turn of it that
     * stored the source. A store that cannot be read files them under turn 0 of no session, and the call goes on.
     */
    const placeOfSource = (source: string): Effect.Effect<{ readonly session: string; readonly turn: number }> =>
      Effect.provideService(knowledgeSession, Sessions, sessionsOf).pipe(
        Effect.flatMap((session) => Effect.map(sessionsOf.read(session), (journal) => ({
          session: String(session),
          turn: Number(journal.events.find((event) => Option.exists(dataOf(sourceEvent, event), (data) => data.id === source))?.turn ?? 0),
        }))),
        Effect.catchCause(() => Effect.succeed({ session: "", turn: 0 })),
      )
    /**
     * A model as the page hands it to the program, watched: each prompt it is sent and the usage it reports are
     * traced under `name`, the name its answers give, and a stream that fails says so (`PromptFailed`). `failures`
     * are what the page makes of this model's next calls (lesson 14's failures.ts), one entry each time it is asked,
     * a try of a call tried again included, a summarizer's call not counted; each `watch` counts from the first, so
     * a build that watches anew starts the list again. A call the page makes fail never reaches the model.
     */
    const watch = (inner: LanguageModel.LanguageModel, name: string, failures: ReadonlyArray<MadeFailure> = []) => {
      let counted = 0
      return LanguageModel.LanguageModel.of({
        ...inner,
        // The prompt is traced when the stream runs, not when it is made: a loop makes the stream first and hands it
        // to `modelAnswer`, which provides the turn only while it reads it.
        streamText: ((options: { readonly prompt: Prompt.RawInput; readonly toolkit?: unknown }) => Stream.unwrap(Effect.gen(function* () {
          const current = yield* Effect.serviceOption(CurrentTurn)
          const summarizing = yield* Summarizing
          const curation = yield* Curating
          // A curator's call (lesson 18) runs in no turn: it is filed on the knowledge session, under its source's turn.
          const { session, turn } = Option.getOrElse(curation, () => Option.match(current, { onNone: guessed, onSome: (running) => ({ session: String(running.id), turn: Number(running.turn) }) }))
          const kit = options.toolkit
          const tools = typeof kit === "object" && kit !== null && "tools" in kit && typeof kit.tools === "object" && kit.tools !== null ? Object.keys(kit.tools) : []
          const purpose = Option.isSome(curation) ? { purpose: "curation" as const } : summarizing ? { purpose: "summary" as const } : {}
          // A stream that runs with a turn was handed to the kernel's `modelAnswer` (or is a summarizer's): the Context
          // tab then names that function, not the lines a loop would write by hand.
          const given = Option.isSome(current) ? { givenTurn: true as const } : {}
          yield* emit({ _tag: "Prompt", session, turn, messages: saidOf(options.prompt), tools, model: name, picked, ...purpose, ...given })
          // A summarizer's call is not one the list counts, nor a curator's.
          const made = summarizing || Option.isSome(curation) ? Option.none() : Option.fromNullishOr(failures[counted++])
          const failed = (reason: string) => emit({ _tag: "PromptFailed", session, turn, reason, ...purpose })
          return Option.match(made, { onNone: () => Reflect.apply(inner.streamText, inner, [options]), onSome: (failure) => madeFailure(name, failure) }).pipe(
            Stream.tap((part: unknown) => Option.match(usageOf(part), { onNone: () => Effect.void, onSome: (usage) => emit({ _tag: "Usage", session, turn, usage, ...purpose }) })),
            // An error the model reports inside its stream fails the attempt too, as `modelAnswer` and `planned` read it.
            Stream.tap((part: unknown) => (Predicate.hasProperty(part, "type") && part.type === "error" ? failed(Predicate.hasProperty(part, "error") ? textOf(part.error) : "the model reported an error") : Effect.void)),
            // A stream stopped (Stop, a rebuild) did not fail: it is not said to.
            Stream.tapCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : failed(failureWords(cause)))),
          )
        }))) as typeof inner.streamText,
      })
    }
    return {
      // Each requires what the real one requires, so a line removed from the stack fails as it would for real.
      kernel: () => Layer.succeed(Core, core),
      inProcessJournal: () => Layer.effect(JournalStorage, Effect.gen(function* () { yield* Core; return storage })),
      sessions: () => Layer.effect(Sessions, Effect.gen(function* () { yield* JournalStorage; yield* Core; return sessionsOf })),
      chatOn: () => Layer.effect(Chat, Effect.gen(function* () { yield* Sessions; return chat })),
      // Where a task's report goes (lesson 17): the chat's one queue, behind what came before it, where the program
      // takes it for a turn of its own. The page is told it waits.
      reportsOn: () => Layer.succeed(TaskReports, TaskReports.of({
        deliver: (report: TaskReport) => Effect.andThen(Queue.offer(queue, { _tag: "Report", report }), emit({ _tag: "Reported", task: report.task, session: report.session })),
      })),
      model: Layer.succeed(LanguageModel.LanguageModel, watch(model.model, picked)),
      // Lesson 14: a second Echo, watched as the model picked is and never failing, and the model picked failing as
      // failures.ts says. Each build calls `failing` once, so the list starts again with every build.
      spare: Layer.succeed(LanguageModel.LanguageModel, watch(this.spare.model, SPARE)),
      failing: (failures) => Layer.succeed(LanguageModel.LanguageModel, watch(model.model, picked, failures)),
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
      // Lesson 18: the model the curator asks. The model picked when it is Echo or the gateway's; a model that runs in
      // the browser cannot read the curation prompt in one request, so the page's Echo curates by rule in its place.
      curatorModel: Layer.succeed(LanguageModel.LanguageModel, curatesItself(model) ? watch(model.model, picked) : watch(this.curatorEcho.model, this.curatorEcho.choice.id)),
      curatesByRule: !curatesItself(model),
      // A model call made inside `curate` is the curator's: it runs with `Curating` set to the knowledge session and the
      // turn that stored its source, which the model watcher reads. Its reply is traced too: nothing of it is stored.
      // The source counts as being kept from the curator's first call, so a source taken up again counts too.
      watchCurator: (layer) => Layer.effect(Curator, Effect.map(Effect.gen(function* () { return yield* Curator }), (curator) => Curator.of({
        curate: (input) => Effect.gen(function* () {
          const place = yield* placeOfSource(input.job.source)
          curatingSources.add(input.job.source)
          curatingPlaces.set(input.job.source, place)
          const reply = yield* curator.curate(input).pipe(Effect.provideService(Curating, Option.some(place)))
          yield* emit({ _tag: "CuratorAnswered", ...place, source: input.job.source, attempt: input.job.attempt, job: input.job.purpose, reply })
          return reply
        }),
      }))).pipe(Layer.provide(layer)),
      // The learner's store is built, and is what the base's storage hands every call to from here on.
      storeOn: (layer) => Layer.effect(JournalStorage, Effect.map(Effect.gen(function* () { return yield* JournalStorage }), (store) => {
        this.store = Option.some(store)
        return storage
      })).pipe(Layer.provide(layer)),
      storage: this.storage,
      chosen: this.chosenChat,
      // The page's workspace, the same one on every build: what the program is given, and what the pane shows.
      files: Option.map(this.files, (files) => Layer.succeed(Files, files)),
      // The learner's `resume` names the conversation; its journal is read before the chat is handed over, so the
      // page draws what is stored before the program takes a message.
      chatWith: (resume) => Layer.effect(Chat, Effect.gen(function* () {
        yield* Sessions
        const session = yield* resume.pipe(Effect.provideService(Sessions, sessionsOf))
        const journal = yield* Effect.mapError(sessionsOf.read(session), (error) => ({ message: `the conversation \`resume\` gave cannot be read: ${error.message}` }))
        const again = shown(session)
        // A branch (lesson 15) says where it was cut, and from which chat of the row, so its copied turns say so.
        const branch = yield* Option.match(Option.fromNullishOr(journal.header.branch), {
          onNone: () => Effect.succeed({}),
          onSome: ({ of, through }) => Effect.map(chatsNow, (chats) => ({ branch: { of: String(of), through: Number(through), label: chats.find((chat) => chat.id === of)?.label ?? "another chat" } })),
        })
        yield* emit({ _tag: "Showing", session, journal: journal.events, ...branch, ...(again ? { again: true as const } : {}) })
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
    this.cutCurations()
  }

  /**
   * The program stopped, asked to or by itself: a curation it ran is cut short and stores nothing more. Its source
   * stays pending, for the next program's turn to take up; the page is told where its calls were filed.
   */
  private cutCurations(): void {
    for (const source of this.curatingSources) {
      const place = this.curatingPlaces.get(source)
      if (place !== undefined) this.emit({ _tag: "CurationCut", ...place, source })
    }
    this.curatingSources.clear()
    this.curatingPlaces.clear()
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
    // A report that waits was written by tasks of the program that stopped, whose ids start again with the next one:
    // it is dropped, on Stop, a rebuild and Clear context alike. The messages that wait stay for the next program.
    const dropped = takeExcept(this.queue, (input) => !isReport(input)).flatMap((input) => (input._tag === "Report" ? [String(input.report.session)] : []))
    if (dropped.length > 0) this.emit({ _tag: "ReportsDropped", sessions: dropped })
    const evaluated = this.lesson.evaluate(sources, this.parts(this.model.value))
    if (evaluated._tag === "Failure") return { _tag: "Refused", message: evaluated.failure }
    const main = evaluated.success
    const scope = await Effect.runPromise(Scope.fork(this.root))
    const fiber = await Effect.runPromise(Effect.forkIn(main.pipe(
      Effect.onExit((exit) => Effect.sync(() => {
        // A stop the page asked for says nothing; an end of the program's own is said, in words, and cuts its curation.
        if (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause)) this.cutCurations()
        if (Exit.isSuccess(exit)) this.emit({ _tag: "Ended", reason: "your program ended: it stopped taking messages." })
        else if (!Cause.hasInterruptsOnly(exit.cause)) this.emit({ _tag: "Ended", reason: `your program stopped: ${buildFailure(exit.cause)}` })
      })),
    ), scope, { startImmediately: true }))
    this.program = Option.some({ fiber, scope })
    return { _tag: "Built" }
  }

  /** Send a message: it waits in the chat's queue until the program takes it. */
  send(text: string): void {
    Queue.offerUnsafe(this.queue, { _tag: "Message", text })
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
    // The messages only: a report that waits is dropped as the program stops, and said so (`ReportsDropped`).
    const dropped = textsOf(takeExcept(this.queue, isReport))
    if (Option.isSome(this.model)) this.model.value.interrupt()
    this.spare.interrupt()
    this.curatorEcho.interrupt()
    return { dropped, result: await this.start(this.last) }
  }

  /**
   * A new, empty conversation in the same base, and the program started again. The old one stays in the journal
   * store. In a durable lesson the program's chat finds the new session as the last one, and shows it.
   */
  async clear(): Promise<BuildResult> {
    takeExcept(this.queue, isReport)
    // The program is stopped first: a turn it has open ends before the new conversation is the one shown.
    await this.stopProgram()
    const created = await Effect.runPromise(Effect.result(Context.get(this.base, Sessions).create({ owner: OWNER })))
    if (created._tag === "Failure") return { _tag: "Refused", message: `a new conversation could not be created: ${created.failure.message}` }
    if (this.lesson.durable === undefined) this.session = created.success
    this.asked = undefined
    // No chat is asked for (lesson 15): the learner's `resume` finds the new one as the latest.
    if (Option.isSome(this.chosenChat)) this.setChosen(Option.none())
    return this.start(this.last)
  }

  /**
   * Show another chat of the row (lesson 15): it is the one asked for from here on, and the program starts again over
   * it, as Rebuild does, a turn in progress ending Interrupted. The messages still waiting are dropped: they were
   * written for the chat that was shown. Returns them, and the build.
   */
  async choose(chat: SessionId): Promise<{ readonly dropped: ReadonlyArray<string>; readonly result: BuildResult }> {
    const dropped = textsOf(takeExcept(this.queue, isReport))
    this.setChosen(Option.some(chat))
    return { dropped, result: await this.start(this.last) }
  }

  /**
   * Make a branch of the conversation shown (lesson 15), cut after `turn`, with the learner's `branchFrom` as it was
   * last built, on the page's own base `Sessions`: the sessions the chat reads, over the store the program built. A
   * kit's stack is no place for it, since a kit runs over a store of its own. Nothing is stopped and nothing
   * switches: a turn running in the chat goes on. The chat shown becomes the one asked for, so a rebuild stays on it
   * and does not move to the branch, which is now the latest. Gives the branch's id, or why none was made, in words.
   */
  async branch(turn: TurnNumber): Promise<Result.Result<SessionId, string>> {
    const make = this.lesson.branch
    if (make === undefined) return Result.fail("this lesson makes no branches.")
    if (!this.running) return Result.fail(NOT_RUNNING)
    const conversation = this.session
    const made = make(this.last, conversation, turn)
    if (Result.isFailure(made)) return Result.fail(made.failure)
    const ran = await Effect.runPromise(Effect.exit(made.success.pipe(Effect.provideService(Sessions, Context.get(this.base, Sessions)))))
    if (Exit.isFailure(ran)) {
      return Result.fail(`branch.ts made no branch: ${Option.match(Cause.findErrorOption(ran.cause), { onNone: () => buildFailure(ran.cause), onSome: textOf })}`)
    }
    this.setChosen(Option.some(conversation))
    return Result.succeed(ran.value)
  }

  /**
   * A session's journal, as stored: the conversation's unless another is named (lesson 18 reads the knowledge session's);
   * none before a durable lesson's program has named a conversation.
   */
  async journal(session: SessionId = this.session): Promise<ReadonlyArray<StoredEvent>> {
    if (session === NO_CONVERSATION) return []
    const journal = await Effect.runPromise(Context.get(this.base, Sessions).read(session))
    return journal.events
  }

  /** Every session the store holds, by creation. */
  async list(): Promise<ReadonlyArray<{ readonly id: string; readonly owner: string; readonly parent?: string; readonly createdAt: number; readonly format: number }>> {
    return Effect.runPromise(Effect.orElseSucceed(Context.get(this.base, Sessions).list, () => []))
  }

  /**
   * Run one of the lesson's kits over the learner's code: each check, passed or what it found. The kit is handed
   * the model as it was loaded, not the one the page watches for the chat: a check that runs on it runs on a stack
   * of its own, and the page hears no prompt of it. A kit that runs alone is refused while a turn runs in the
   * chat, and `checking` is true while it runs.
   */
  async runKit(id: string, sources: Sources): Promise<Result.Result<ReadonlyArray<KitResult>, string>> {
    const kit = this.lesson.kits?.[id]
    if (kit === undefined) return Result.fail(`this lesson has no kit named ${id}`)
    const alone = kit.alone === true
    const refused = this.notAlone()
    if (alone && Option.isSome(refused)) return Result.fail(refused.value)
    const model = Option.map(this.model, (loaded) => Layer.succeed(LanguageModel.LanguageModel, loaded.model))
    const checks = kit.checks(sources, memoryStore, model)
    if (Result.isFailure(checks)) return Result.fail(checks.failure)
    const limit = kit.timeout ?? KIT_TIMEOUT
    if (alone) this.kitAlone = true
    try {
      const ran = await Effect.runPromise(Effect.forEach(checks.success, (check) => Effect.exit(Effect.timeout(check.run, limit)).pipe(
        Effect.map((exit): KitResult => Exit.isSuccess(exit)
          // A check that passes may say something, as text: any other value says nothing.
          ? { id: check.id, name: check.name, passed: true, message: typeof exit.value === "string" ? exit.value : "" }
          : { id: check.id, name: check.name, passed: false, message: Option.match(Cause.findErrorOption(exit.cause), { onNone: () => buildFailure(exit.cause), onSome: textOf }) }),
      ), { concurrency: 1 }))
      return Result.succeed(ran)
    } finally {
      if (alone) this.kitAlone = false
    }
  }

  /**
   * Run work that takes turns with the chat, as a kit that runs alone does (lesson 13's evals): refused while a turn
   * runs (`TURN_RUNNING`) or while another such run is under way, and `checking` is true from the call until it is
   * over. `start` is handed the model picked as it was loaded, not the one the page watches for the chat, so the
   * page hears no prompt of it, and gives the work or why there is none; it may load what the work needs first.
   * The work runs on a fiber of its own, which `stopAlone` interrupts. What comes back is how it ended: a run that
   * was stopped ends interrupted.
   */
  async runAlone<A>(start: (model: Option.Option<LoadedModel>) => Promise<Result.Result<Effect.Effect<A, unknown>, string>>): Promise<Result.Result<Exit.Exit<A, unknown>, string>> {
    const refused = this.notAlone()
    if (Option.isSome(refused)) return Result.fail(refused.value)
    this.kitAlone = true
    try {
      const made = await start(this.model)
      if (Result.isFailure(made)) return Result.fail(made.failure)
      const fiber = Effect.runFork(made.success)
      this.aloneRun = Option.some(fiber)
      return Result.succeed(await Effect.runPromise(Fiber.await(fiber)))
    } finally {
      this.aloneRun = Option.none()
      this.kitAlone = false
    }
  }

  /**
   * Load the lesson's world into the knowledge session (lesson 18, `Lesson.graph`), on the page's own base `Sessions`,
   * the sessions the program reads. It takes turns with the chat, as a kit that runs alone does: refused while a turn
   * runs (`TURN_RUNNING`), while the curator keeps a turn (`CURATING`) or while another such run is under way, and
   * `checking` is true until it is over, so the page's Send, chips and model picker are off. Gives what was stored in
   * words, or why nothing was.
   */
  async loadWorld(): Promise<Result.Result<string, string>> {
    const graph = this.lesson.graph
    if (graph === undefined) return Result.fail("this lesson has no world to load.")
    const refused = this.notAlone()
    if (Option.isSome(refused)) return Result.fail(refused.value)
    this.kitAlone = true
    try {
      const ran = await Effect.runPromise(Effect.exit(graph.load.pipe(Effect.provideService(Sessions, Context.get(this.base, Sessions)))))
      return Exit.isSuccess(ran) ? Result.succeed(ran.value) : Result.fail(Option.match(Cause.findErrorOption(ran.cause), { onNone: () => buildFailure(ran.cause), onSome: (words) => words }))
    } finally {
      this.kitAlone = false
    }
  }

  /** Stop the run `runAlone` started, where it is: it ends interrupted. Nothing happens while none runs. */
  async stopAlone(): Promise<void> {
    if (Option.isSome(this.aloneRun)) await Effect.runPromise(Fiber.interrupt(this.aloneRun.value))
  }

  async dispose(): Promise<void> {
    await this.stopAlone()
    await this.stopProgram()
    await Effect.runPromise(Scope.close(this.root, Exit.void))
  }
}
