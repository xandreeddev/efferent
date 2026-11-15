// What a lesson hands the workbench: its files, how its code becomes a
// program, and the controls and experiments its steps point at. The
// workbench knows nothing of any one lesson; each lesson's definition lives
// in lessons/<slug>/.
import { Option } from "effect"
import type { Effect, Layer, Result } from "effect"
import type { LanguageModel } from "effect/ai"
import type { ConformanceCheck, Core, JournalStorage, SessionId, Sessions } from "@xandreed/core/kernel"
import type { Approval, KeyValueStore, Memory, Summarizer } from "@xandreed/sdk/kernel"
import type { Chat } from "./page-chat.ts"

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
   * Who a tool asks before it acts (lesson 9): the page. A question is put to the person in the chat, and the
   * tool waits for the answer; a question whose turn is dropped is taken back.
   */
  readonly approvalOn: (pane: unknown) => Layer.Layer<Approval>
}

/** A kit a lesson's page can run over the learner's code: its checks, or why the code did not evaluate. */
export type LessonKit = (sources: Sources, storageOf: () => KeyValueStore) => Result.Result<ReadonlyArray<ConformanceCheck>, string>

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
  /** The kits the page's "Run the kit" buttons run, by `data-kit` id. */
  readonly kits?: Readonly<Record<string, LessonKit>>
}
