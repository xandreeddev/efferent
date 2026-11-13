// What a lesson hands the workbench: its files, how its code becomes an agent,
// and the controls and experiments its steps point at. The workbench knows
// nothing of any one lesson; each lesson's definition lives in lessons/<slug>/.
import type { Option, Result } from "effect"

/** A part of the editable file's text, by offsets. */
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

/** One file of the Code pane: read-only text around one editable part. */
export interface LessonFile {
  /** What a step names it by (`file="…"` on a step) and the key of its text in `Sources`. */
  readonly id: string
  /** Its tab's label. */
  readonly label: string
  /** The editable part as the lesson starts. */
  readonly defaultText: string
  /** The whole file around a given editable part. */
  readonly documentOf: (editable: string) => string
  /** Where the editable part starts in `documentOf(...)`. */
  readonly editableFrom: number
  /** What goes before the editable part to format it as a statement, such as `const Agent = `. */
  readonly formatPrefix: string
  /** The read-only sections a step may fold or unfold, in order. */
  readonly sections: ReadonlyArray<LessonSection>
}

/** The editable text of each file, by file id. */
export type Sources = Readonly<Record<string, string>>

/** A control of the lesson, bound to a line of the main file: it reads the value there, and writes it back. */
export interface LessonControl {
  readonly read: (source: string) => Option.Option<string | number>
  /** The new source, or None when the line is not in it. */
  readonly write: (source: string, value: string | number) => Option.Option<string>
}

/** What memory reported when it refused a request over the budget. */
export interface Refusal {
  readonly budgetTokens: number
  readonly estimatedTokens: number
}

export interface Lesson {
  /** The lesson's page slug, as in /learn/<slug>. */
  readonly slug: string
  readonly files: ReadonlyArray<LessonFile>
  /** The file the controls and experiments edit, and the one shown when a step names none. */
  readonly mainFile: string
  /** One-click messages under the chat box. */
  readonly chips: ReadonlyArray<string>
  /** "Send three at once". */
  readonly three: ReadonlyArray<string>
  /** What a `data-fill` button sends, all at once. */
  readonly fill: ReadonlyArray<string>
  /** By `data-control` key. */
  readonly controls: Readonly<Record<string, LessonControl>>
  /** By `data-exp` id: the main file's new source, or None when its line is not there. */
  readonly experiments: Readonly<Record<string, (source: string) => Option.Option<string>>>
  /** After memory refused a request: the budget a "Raise budget" button offers, written through the `budgetTokens` control; None offers none. */
  readonly raisedBudget: (refused: Refusal) => Option.Option<number>
  /** The learner's code as a layer to build, or why it did not run, in words. */
  readonly evaluate: (sources: Sources) => Result.Result<unknown, string>
}
