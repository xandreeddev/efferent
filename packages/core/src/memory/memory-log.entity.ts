import { Schema } from "effect"
import { AgentMessage, ToolCallId } from "../domain/message.entity.js"
import { DecisionId } from "../decision-record.entity.js"

/**
 * The conversation memory log — the single source every model request is
 * rebuilt from ("model-visible ⟺ logged"). Entries are appended, never edited:
 * a compaction is itself an entry that carries the replacement bytes, so a
 * replay reproduces exactly what the model saw.
 */

/** `<journal seq>:<index within the append>` — stable across processes. */
export const EntryId = Schema.NonEmptyTrimmedString.pipe(Schema.brand("EntryId"))
export type EntryId = typeof EntryId.Type

/** Something a tool result discovered, e.g. a record the next turn may cite. */
export const Subject = Schema.Struct({
  kind: Schema.NonEmptyTrimmedString,
  id: Schema.NonEmptyTrimmedString,
  label: Schema.OptionFromNullOr(Schema.String),
  data: Schema.OptionFromNullOr(Schema.Unknown),
})
export type Subject = typeof Subject.Type

export const CompactionAction = Schema.Union(
  /** Older tool results shown through their compact views (texts align with entries). */
  Schema.TaggedStruct("CompactViews", { entries: Schema.Array(EntryId), texts: Schema.Array(Schema.String) }),
  /** One large result replaced by a preview; the full value stays resolvable. */
  Schema.TaggedStruct("Spill", { entry: EntryId, preview: Schema.String }),
  /** Whole turns up to `throughTurn` replaced by a ledger. */
  Schema.TaggedStruct("DropTurns", { throughTurn: Schema.Int, ledger: Schema.String }),
  /** Everything before `keepFromTurn` replaced by a summary. */
  Schema.TaggedStruct("Summarize", { keepFromTurn: Schema.Int, summary: Schema.String }),
)
export type CompactionAction = typeof CompactionAction.Type

export const ActivationSource = Schema.Literal("always", "matcher", "load_skill", "host")
export type ActivationSource = typeof ActivationSource.Type

export const LogBody = Schema.Union(
  Schema.TaggedStruct("SystemPrepared", {
    fingerprint: Schema.String,
    text: Schema.String,
    sections: Schema.Array(Schema.Struct({ id: Schema.String, version: Schema.String, fingerprint: Schema.String })),
  }),
  Schema.TaggedStruct("TurnStarted", { prompt: Schema.String }),
  Schema.TaggedStruct("TurnContext", { sectionId: Schema.String, version: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("Message", { message: AgentMessage }),
  Schema.TaggedStruct("ToolResult", {
    toolCallId: ToolCallId,
    toolName: Schema.String,
    isError: Schema.Boolean,
    /** Full fidelity: the tool's encoded result. */
    encoded: Schema.Unknown,
    /** The exact text the model saw when the result was written. */
    view: Schema.String,
    viewVersion: Schema.String,
    subjects: Schema.Array(Subject),
    /** Pinned results survive every compaction verbatim. */
    pinned: Schema.Boolean,
  }),
  Schema.TaggedStruct("StepContext", { step: Schema.Int, text: Schema.String }),
  Schema.TaggedStruct("ToolsActivated", {
    skills: Schema.Array(Schema.String),
    tools: Schema.Array(Schema.String),
    source: ActivationSource,
    decision: Schema.OptionFromNullOr(DecisionId),
  }),
  Schema.TaggedStruct("Compaction", { strategy: Schema.String, version: Schema.String, action: CompactionAction }),
  Schema.TaggedStruct("TurnEnded", {
    outcome: Schema.Literal("completed", "partial", "failed"),
    reply: Schema.OptionFromNullOr(Schema.String),
  }),
)
export type LogBody = typeof LogBody.Type

export const LogEntry = Schema.Struct({
  id: EntryId,
  seq: Schema.Int,
  runId: Schema.String,
  turn: Schema.Int,
  step: Schema.Int,
  at: Schema.Number,
  body: LogBody,
})
export type LogEntry = typeof LogEntry.Type

/** The journal payload one append writes. Bodies are canonical JSON, so their
 *  bytes survive any store (jsonb reorders keys); ids come from the journal. */
export const LogAppendPayload = Schema.Struct({
  v: Schema.Literal(1),
  turn: Schema.Int,
  step: Schema.Int,
  bodies: Schema.String,
})
export type LogAppendPayload = typeof LogAppendPayload.Type

/** The journal event name the log is stored under. */
export const MemoryEntriesEvent = Schema.Literal("memory.entries")

/** The model-visible rebuild of the log for one request. */
export const BuiltContext = Schema.Struct({
  messages: Schema.Array(AgentMessage),
  fingerprint: Schema.String,
  estimatedTokens: Schema.Int,
  compactions: Schema.Array(EntryId),
})
export type BuiltContext = typeof BuiltContext.Type
