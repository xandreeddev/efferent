import { Schema, Effect } from "effect"

/**
 * The CONTEXT SET — what the human chose for the model to see on top of the
 * spec and the conversation. Two halves:
 * - STANDING sources the harness discovers on its own (the workspace rules
 *   file, forge lessons, the curated memory, the armed quality bar), each
 *   switchable OFF here;
 * - PINNED sources the human adds on demand: a file, a directory listing, a
 *   glob, a note, another spec, a run's findings, a git diff, a command's
 *   output.
 * Persisted per workspace as `.efferent/context.json`; assembled into ONE
 * prompt block when a turn needs it. Selection is the human's; assembly is
 * deterministic and bounded.
 */

export const StandingSource = Schema.Literals(["rules", "lessons", "memory", "doctrine"])
export type StandingSource = typeof StandingSource.Type
export const STANDING_SOURCES: ReadonlyArray<StandingSource> = [
  "rules",
  "lessons",
  "memory",
  "doctrine",
]

/** Every pin can be switched off without being dropped. */
const On = Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => true)), Schema.withConstructorDefault(Effect.sync(() => true)))

export const FilePin = Schema.TaggedStruct("file", { path: Schema.NonEmptyString, on: On })
export const DirPin = Schema.TaggedStruct("dir", { path: Schema.NonEmptyString, on: On })
export const GlobPin = Schema.TaggedStruct("glob", { pattern: Schema.NonEmptyString, on: On })
export const NotePin = Schema.TaggedStruct("note", { text: Schema.NonEmptyString, on: On })
export const SpecPin = Schema.TaggedStruct("spec", { slug: Schema.NonEmptyString, on: On })
export const RunPin = Schema.TaggedStruct("run", { id: Schema.NonEmptyString, on: On })
export const DiffPin = Schema.TaggedStruct("diff", {
  /** The git ref to diff against; absent = the working tree vs HEAD. */
  ref: Schema.OptionFromOptional(Schema.NonEmptyString),
  on: On,
})
export const CmdPin = Schema.TaggedStruct("cmd", { command: Schema.NonEmptyString, on: On })

export const ContextPin = Schema.Union([FilePin, DirPin, GlobPin, NotePin, SpecPin, RunPin, DiffPin, CmdPin])
export type ContextPin = typeof ContextPin.Type

export class ContextSet extends Schema.Class<ContextSet>("ContextSet")({
  version: Schema.Literal(1),
  /** Standing sources switched OFF; everything not listed stays on. */
  off: Schema.Array(StandingSource),
  pins: Schema.Array(ContextPin),
  /** The assembled block's cap, in characters (tokens ≈ chars / 4). */
  budgetChars: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1_000, maximum: 200_000 }))),
}) {}
