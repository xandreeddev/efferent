import { createHash } from "node:crypto"
import { JsonSchema, Option, Schema } from "effect"
import { JOURNAL_KINDS, journalSchemaOf, MediaEnvelope, MediaReference, SessionHeader, SessionLogEvent } from "@xandreed/core"
import { TASK_ANSWERED, TASK_QUESTIONED, TASK_CANCELLED, TASK_RESULT, TASK_STARTED, TaskAnswered, TaskQuestioned, TaskCancelled, TaskResult, TaskStarted } from "@xandreed/plugin-tasks"
// The sessions plugin keeps its head state inside the package; the fingerprint reads its schema from the entity file.
import { SessionsState } from "../packages/plugin-sessions/src/sessions-state.entity.js"

/*
 * The checks behind `STORED_FORMAT` (`packages/core/src/session/stored-format.entity.ts`):
 * every shape the framework stores in a session log, fingerprinted, and the
 * record of which fingerprint each format had (`docs/stored-format.json`).
 * `generate-stored-format.ts` runs them in `bun run docs:generate` and fails
 * on any problem, so a stored shape cannot change without a bump.
 */

/** The record kept in `docs/stored-format.json`. */
export const StoredFormatRecord = Schema.Struct({
  /** The format the shapes below are. */
  format: Schema.Int,
  fingerprint: Schema.String,
  /** Each shape's own fingerprint, by name: what changed, when the whole does. */
  shapes: Schema.Record(Schema.String, Schema.String),
  /** Every format and its fingerprint, from 1, one row per format, appended and never rewritten. */
  history: Schema.Array(Schema.Struct({ format: Schema.Int, fingerprint: Schema.String })),
})
export type StoredFormatRecord = typeof StoredFormatRecord.Type

/** A stored shape: its name in the record and its schema. */
export interface StoredShape {
  readonly name: string
  readonly schema: Schema.Top
}

/**
 * Every shape the framework stores in a session log: each journal kind's
 * payload, the log's own rows, the tasks plugin's records and the sessions
 * plugin's head state. A journal kind without a schema is a problem, not a
 * shape left out.
 */
export const storedShapes = (): { readonly shapes: ReadonlyArray<StoredShape>; readonly problems: ReadonlyArray<string> } => {
  const kinds = JOURNAL_KINDS.map((kind) => ({ kind, schema: journalSchemaOf(kind) }))
  return {
    shapes: [
      ...kinds.flatMap(({ kind, schema }) => Option.match(schema, { onNone: () => [], onSome: (found) => [{ name: `journal ${kind}`, schema: found }] })),
      { name: "SessionHeader", schema: SessionHeader },
      { name: "SessionLogEvent", schema: SessionLogEvent },
      { name: "physical MediaReference", schema: MediaReference },
      { name: "physical MediaEnvelope", schema: MediaEnvelope },
      { name: `record ${TASK_STARTED}`, schema: TaskStarted },
      { name: `record ${TASK_RESULT}`, schema: TaskResult },
      { name: `record ${TASK_CANCELLED}`, schema: TaskCancelled },
      { name: `record ${TASK_QUESTIONED}`, schema: TaskQuestioned },
      { name: `record ${TASK_ANSWERED}`, schema: TaskAnswered },
      { name: "SessionsState", schema: SessionsState },
    ],
    problems: kinds.filter(({ schema }) => Option.isNone(schema)).map(({ kind }) => `Journal kind ${kind} has no journal schema (journalSchemaOf)`),
  }
}

/** The keys that only explain a shape: a change to them is not a change a reader can tell. */
const WORDING = new Set(["description", "title", "examples", "$comment"])

const isObject = (value: unknown): value is { readonly [key: string]: unknown } => typeof value === "object" && value !== null && !Array.isArray(value)

/** A JSON value without its wording, its object keys sorted. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isObject(value)
      ? Object.fromEntries(Object.keys(value).filter((key) => !WORDING.has(key)).toSorted().map((key) => [key, canonical(value[key])]))
      : value

/**
 * A shape as canonical JSON: its JSON Schema (draft 07, as the event
 * reference renders it) without descriptions, titles, examples or comments,
 * keys sorted. A field, a type, an optionality or a check changes it; a
 * description does not.
 */
export const canonicalShape = (schema: Schema.Top): string => {
  const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(schema))
  return JSON.stringify(canonical({ schema: document.schema, definitions: document.definitions }))
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

/** Each shape's fingerprint, and the whole's: the shapes' fingerprints in name order. */
export const fingerprintOf = (shapes: ReadonlyArray<StoredShape>): { readonly fingerprint: string; readonly shapes: Readonly<Record<string, string>> } => {
  const each = Object.fromEntries(shapes.map(({ name, schema }) => [name, sha256(canonicalShape(schema))] as const).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  return { fingerprint: sha256(Object.entries(each).map(([name, hash]) => `${name} ${hash}`).join("\n")), shapes: each }
}

/** The names whose fingerprint differs between two records of the shapes (added and removed ones included). */
const changedShapes = (before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]).toSorted()

/**
 * What does not hold between the recorded formats, the shapes as the code
 * has them and `STORED_FORMAT` (`format`). Empty when they agree:
 * - the history runs from 1 with no gap and no format twice;
 * - `format` is the last recorded one, or the next (a bump: the generator
 *   appends its row), never lower and never further;
 * - at the last recorded format, the fingerprint is the one recorded: a
 *   stored shape that changed without a bump is named;
 * - a bump comes with a change: the next format's shapes differ from the last.
 * No record yet is clean at format 1: the first generation writes it.
 */
export const formatProblems = (recorded: Option.Option<StoredFormatRecord>, current: ReturnType<typeof fingerprintOf>, format: number): ReadonlyArray<string> =>
  Option.match(recorded, {
    onNone: () => format === 1 ? [] : [`docs/stored-format.json is missing: STORED_FORMAT is ${format}, and a first record starts at 1`],
    onSome: (record) => {
      const history = record.history
      const gaps = history.flatMap((row, index) => row.format === index + 1 ? [] : [`The stored format history is not 1, 2, 3…: row ${index + 1} is format ${row.format}`])
      const last = history.at(-1)?.format ?? 0
      const order = format < last
        ? [`STORED_FORMAT is ${format}, below the last recorded format ${last}: a format is never lowered`]
        : format > last + 1 ? [`STORED_FORMAT is ${format}, but the last recorded format is ${last}: bump it by one`] : []
      const unbumped = format === last && history.at(-1)?.fingerprint !== current.fingerprint
        ? [`A stored shape changed (${changedShapes(record.shapes, current.shapes).join(", ")}) without a bump: raise STORED_FORMAT in packages/core/src/session/stored-format.entity.ts to ${last + 1} and name the change in CHANGELOG.md`]
        : []
      const idle = format === last + 1 && history.at(-1)?.fingerprint === current.fingerprint
        ? [`STORED_FORMAT was raised to ${format}, but no stored shape changed since format ${last}: a format names a change`]
        : []
      return [...gaps, ...order, ...unbumped, ...idle]
    },
  })

/** The record to write: the current shapes at `format`, a history row appended when `format` is new. */
export const nextRecord = (recorded: Option.Option<StoredFormatRecord>, current: ReturnType<typeof fingerprintOf>, format: number): StoredFormatRecord => {
  const history = Option.match(recorded, { onNone: () => [], onSome: (record) => record.history })
  return {
    format,
    fingerprint: current.fingerprint,
    shapes: current.shapes,
    history: history.some((row) => row.format === format) ? history : [...history, { format, fingerprint: current.fingerprint }],
  }
}
