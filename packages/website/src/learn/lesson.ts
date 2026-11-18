// What a lesson hands the workbench: its files, how its code becomes a
// program, and the controls and experiments its steps point at. The
// workbench knows nothing of any one lesson; each lesson's definition lives
// in lessons/<slug>/.
import { Option } from "effect"
import type { Duration, Effect, Layer, Result } from "effect"
import type { LanguageModel } from "effect/ai"
import type { Core, JournalStorage, SessionId, Sessions, TurnNumber } from "@xandreed/core/kernel"
import type { Approval, Files, KeyValueStore, Memory, Summarizer, TaskReports } from "@xandreed/sdk/kernel"
import type { Chat } from "./page-chat.ts"
import type { EvalsView } from "./lessons/evals/board.ts"
import type { GradersView } from "./lessons/grade-the-grader/board.ts"
import type { LoadedModel } from "./models/types.ts"
import type { KitResult } from "./runtime.ts"

/** A part of a file's text, by offsets. */
export interface Range {
  readonly from: number
  readonly to: number
}

/** A read-only part of a file the Code pane can fold to a chip. */
export interface LessonSection {
  readonly id: string
  /** The chip's text while it is folded. */
  readonly label: string
  /** Where it is in the whole file, given where the editable part is. */
  readonly range: (doc: string, editable: Range) => Range
}

/** One file of the Code pane: read-only text around one editable part, or read-only throughout. */
export interface LessonFile {
  /** What a step names it by (`file="…"` on a step) and the key of its text in `Sources`. */
  readonly id: string
  /** Its tab's label. */
  readonly label: string
  /** The editable part as the lesson starts (empty for a read-only file). */
  readonly defaultText: string
  /** The whole file around a given editable part. */
  readonly documentOf: (editable: string) => string
  /** Where the editable part starts in `documentOf(...)`. */
  readonly editableFrom: number
  /** What goes before the editable part to format it, such as `const flatMemory = `; empty for statements. */
  readonly formatPrefix: string
  /** The read-only sections a step may fold or unfold, in order. */
  readonly sections: ReadonlyArray<LessonSection>
  /** The sections folded while no step says otherwise. */
  readonly folded: ReadonlyArray<string>
  /** Shown, never edited: the learner reads it. */
  readonly readOnly: boolean
}

/** The editable text of each file, by file id. */
export type Sources = Readonly<Record<string, string>>

/** A control of the lesson, bound to a line of one file: it reads the value there, and writes it back. */
export interface LessonControl {
  readonly file: string
  readonly read: (source: string) => Option.Option<string | number>
  /** The new source, or None when the line is not in it. */
  readonly write: (source: string, value: string | number) => Option.Option<string>
}

/** A change to one file's code. */
export interface LessonEdit {
  readonly file: string
  /** The file's new source, or None when its line is not there. */
  readonly apply: (source: string) => Option.Option<string>
}

/**
 * An experiment: a change to one file's code, then a rebuild. One that needs a second file changed with the first
 * (lesson 11's `recall-tool`: a tool in tools.ts, and no wrapper in memory.ts) lists it under `also`.
 */
export interface LessonExperiment extends LessonEdit {
  /** The other files the experiment edits, each as the first is. */
  readonly also?: ReadonlyArray<LessonEdit>
}

/**
 * Every file an experiment edits, with its new source, the experiment's own file first: all of them, or None when
 * one of them no longer holds its line, so an experiment is never half applied. `source` gives a file's text as
 * it stands.
 */
export const applyExperiment = (experiment: LessonExperiment, source: (file: string) => string): Option.Option<ReadonlyArray<readonly [file: string, text: string]>> =>
  Option.all([experiment, ...(experiment.also ?? [])].map((edit) => Option.map(edit.apply(source(edit.file)), (text) => [edit.file, text] as const)))

/**
 * What the page gives the learner's code under the hood, as the names the
 * code uses: stand-ins for the base layers (built once, so the journal and
 * the chat outlive every rebuild), the model picked, and a wrapper the page
 * puts around the learner's memory to see each context it builds.
 */
export interface PageParts {
  readonly kernel: () => Layer.Layer<Core>
  readonly inProcessJournal: () => Layer.Layer<JournalStorage, never, Core>
  readonly sessions: () => Layer.Layer<Sessions, never, JournalStorage | Core>
  readonly chatOn: (pane: unknown) => Layer.Layer<Chat, never, Sessions>
  readonly model: Layer.Layer<LanguageModel.LanguageModel>
  readonly pane: unknown
  readonly watchMemory: <E, R>(layer: Layer.Layer<Memory, E, R>) => Layer.Layer<Memory, E, R>
  /** A wrapper around the learner's summarizer (lesson 5), so the page tells its model calls from the turn's. */
  readonly watchSummarizer: <E, R>(layer: Layer.Layer<Summarizer, E, R>) => Layer.Layer<Summarizer, E, R>
  /**
   * A durable lesson's store (lesson 7): the learner's layer is built, and the base's sessions, the page's own
   * reads and the program all go through it from then on.
   */
  readonly storeOn: <E, R>(layer: Layer.Layer<JournalStorage, E, R>) => Layer.Layer<JournalStorage, E, R>
  /** What the program is handed as `localStorage`: the browser's, seen through the lesson's own prefix. */
  readonly storage: KeyValueStore
  /**
   * A durable lesson's chat: `resume` is the learner's, run over the sessions each time the program starts,
   * and the conversation it gives is the one the chat and the Context tab show.
   */
  readonly chatWith: (resume: Effect.Effect<SessionId, { readonly message: string }, Sessions>) => Layer.Layer<Chat, { readonly message: string }, Sessions>
  /**
   * The chat the page asks to show (lesson 15): the one picked in the row of chats, or the one shown when a branch
   * was made, so that a rebuild does not move to the branch; none after Clear context and on a new tab. The
   * learner's `resume` is given it as `chosen`, and decides.
   */
  readonly chosen: Option.Option<SessionId>
  /**
   * Who a tool asks before it acts (lesson 9): the page. A question is put to the person in the chat, and the
   * tool waits for the answer; a question whose turn is dropped is taken back.
   */
  readonly approvalOn: (pane: unknown) => Layer.Layer<Approval>
  /**
   * Where a background task's report goes (lesson 17, ADR 0018): the page's `TaskReports`, whose `deliver` puts the
   * report into the chat's one queue, behind the messages and reports that came before it. The program takes it
   * from `Chat.inputs` for a turn of its own; `drain` leaves it. A report still waiting when the program stops is
   * dropped.
   */
  readonly reportsOn: (pane: unknown) => Layer.Layer<TaskReports>
  /**
   * The spare (lesson 14): a second Echo, named `echo-spare`, watched as the model picked is (its prompts and usage
   * traced under its name) and never failing. A plan's second step provides it.
   */
  readonly spare: Layer.Layer<LanguageModel.LanguageModel>
  /**
   * The model picked, failing as `failures` says (lesson 14's failures.ts): one entry each time it is asked, in
   * order, a try of a call tried again included and a summarizer's call not counted, then it answers as it does.
   * A call made to fail never reaches the model. The list counts from its first entry each time this is called:
   * the lesson calls it once a build, so the list starts again with every build.
   */
  readonly failing: (failures: ReadonlyArray<MadeFailure>) => Layer.Layer<LanguageModel.LanguageModel>
  /**
   * The page's workspace (lesson 16), for a lesson that declares one (`Lesson.workspace`): one `Files`, built once
   * per runtime from the lesson's seed and given as a value, so the files outlive every build (Rebuild, Stop, Clear
   * context, an experiment) and a reload starts them over. None for every other lesson.
   */
  readonly files: Option.Option<Layer.Layer<Files>>
}

/**
 * One call of the model picked that the page makes fail (lesson 14): the fields of the kernel's scripted model's
 * `Fails`. `retryable` makes it a provider's own error, worth another try, and without it an unknown error; with
 * `pieces` the answer starts, shows them, then fails, and without them it fails before anything.
 */
export interface MadeFailure {
  readonly retryable?: boolean
  readonly pieces?: ReadonlyArray<string>
}

/**
 * One check a kit hands the page: its id, its name, and an Effect that fails with what the check found. A check of
 * a kernel kit (`ConformanceCheck`) is one. A check that passes may say something too, as text: lesson 12's live
 * check says how many of its runs passed.
 */
export interface KitCheck {
  readonly id: string
  readonly name: string
  readonly run: Effect.Effect<unknown, unknown>
}

/**
 * One check as the page's list draws it: whether it passed, its mark and id, in bold, and the words after them.
 * A check that passed and said nothing reads as its name alone.
 */
export const kitLine = (check: KitResult): { readonly state: "passed" | "failed"; readonly head: string; readonly detail: string } => ({
  state: check.passed ? "passed" : "failed",
  head: `${check.passed ? "✓" : "✗"} ${check.id}`,
  detail: check.message === "" ? check.name : `${check.name}: ${check.message}`,
})

/** A kit a lesson's page can run over the learner's code. */
export interface LessonKit {
  /**
   * The kit's checks, or why the code did not evaluate. `storageOf` gives an empty storage each time it is called.
   * `model` is the model picked, as it was loaded and not as the page watches it for the chat, so the page hears
   * nothing of a check that runs on it; none while no model is picked.
   */
  readonly checks: (sources: Sources, storageOf: () => KeyValueStore, model: Option.Option<Layer.Layer<LanguageModel.LanguageModel>>) => Result.Result<ReadonlyArray<KitCheck>, string>
  /** How long one check may run before it is stopped and counted as failed: five seconds when the kit states none. */
  readonly timeout?: Duration.Input
  /**
   * The kit runs the learner's program on the model picked (lesson 12), so it and the chat take turns: it is
   * refused while a turn runs, and the chat takes no message while it runs.
   */
  readonly alone?: true
}

export interface Lesson {
  /** The lesson's page slug, as in /learn/<slug>. */
  readonly slug: string
  readonly files: ReadonlyArray<LessonFile>
  /** The file shown when a step names none. */
  readonly mainFile: string
  /** One-click messages under the chat box. */
  readonly chips: ReadonlyArray<string>
  /** "Send three at once". */
  readonly three: ReadonlyArray<string>
  /** What a `data-fill` button sends, all at once. */
  readonly fill: ReadonlyArray<string>
  /** By `data-control` key. */
  readonly controls: Readonly<Record<string, LessonControl>>
  /** By `data-exp` id. */
  readonly experiments: Readonly<Record<string, LessonExperiment>>
  /** The learner's code as the program to run, or why it did not evaluate, in words. */
  readonly evaluate: (sources: Sources, parts: PageParts) => Result.Result<Effect.Effect<unknown, unknown>, string>
  /**
   * A lesson whose conversation outlives the page (lesson 7). The page creates no session and keeps no journal
   * of its own: the learner's store does, under this prefix of the browser's storage, and the learner's chat
   * names the conversation to show.
   */
  readonly durable?: { readonly prefix: string }
  /**
   * How a branch is made (lesson 15), from the code as it was last built: the learner's `branchFrom` called with the
   * conversation shown and the turn a "Branch after turn N" button names, as an Effect over the sessions the page's
   * chat reads, or why the code made none. The runtime provides its own base `Sessions` and runs it.
   */
  readonly branch?: (sources: Sources, conversation: SessionId, turn: TurnNumber) => Result.Result<Effect.Effect<SessionId, { readonly message: string }, Sessions>, string>
  /**
   * The page's workspace (lesson 16): the files it starts with, by path. The runtime builds one `Files` in memory
   * from them, once, given to the program as `PageParts.files`; the page's file pane shows and edits the same one.
   */
  readonly workspace?: { readonly seed: Readonly<Record<string, string>> }
  /**
   * The chat shows a chip for each background task the conversation started (lesson 17): running, ended, its report
   * waiting, reported, cancelled, stopped with the program, or its report dropped (`task-chips.ts`).
   */
  readonly tasks?: true
  /**
   * The lesson's graph (lesson 18): the Graph tab beside Context, which draws what the walk of each request did, and
   * the world a `data-world` button ("Load the world") writes into the graph session. The load takes turns with the
   * chat (`runtime.loadWorld`).
   */
  readonly graph?: {
    /**
     * Load the world: every sentence stored in the graph session in one turn, with no tool call, or nothing. What it
     * stored, in words, or why it stored nothing. The runtime provides its own base `Sessions`.
     */
    readonly load: Effect.Effect<string, string, Sessions>
  }
  /** The kits the page's `data-kit` buttons run ("Run the kit", lesson 12's "Run checks"), by `data-kit` id. */
  readonly kits?: Readonly<Record<string, LessonKit>>
  /**
   * The lesson's evals (lesson 13, "Run evals", a `data-evals` button). The part of the page that runs them, with
   * the eval package it brings, is loaded when the button is pressed, so no other lesson's page carries the package.
   * The run takes turns with the chat (`runtime.runAlone`).
   */
  readonly evals?: {
    /**
     * What `runtime.runAlone` is handed: given the model picked, the run of the files as they stand, or why there is
     * none, in words. `changed` is told the table as it fills, and once more when the run is over, however it ended.
     */
    readonly start: (sources: Sources, changed: (view: EvalsView) => void) => (model: Option.Option<LoadedModel>) => Promise<Result.Result<Effect.Effect<EvalsView>, string>>
  }
  /**
   * The lesson's check of its graders against labels a person wrote (lesson 19, "Check the graders", a `data-graders`
   * button). As lesson 13's evals: the part of the page that runs it, with the eval package, is loaded when the button
   * is pressed, and the run takes turns with the chat (`runtime.runAlone`).
   */
  readonly calibration?: {
    /**
     * What `runtime.runAlone` is handed: the check of the files as they stand, or why there is none, in words. It
     * needs no model. `changed` is told the table as it fills, and once more when the run is over, however it ended.
     */
    readonly start: (sources: Sources, changed: (view: GradersView) => void) => (model: Option.Option<LoadedModel>) => Promise<Result.Result<Effect.Effect<GradersView>, string>>
  }
}
