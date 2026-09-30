import { Schema } from "effect"
import { AgentMessage, ToolCallId } from "../domain/message.entity.js"
import { DecisionId } from "../decision-record.entity.js"
import { UserMessageFromString } from "../turn/user-message.entity.js"

/**
 * The conversation memory log — the single source every model request is
 * rebuilt from ("model-visible ⟺ logged"). Entries are appended, never edited:
 * a compaction is itself an entry that carries the replacement bytes, so a
 * replay reproduces exactly what the model saw.
 */

/** `<runId>:<index within the run>` — assigned by memory, independent of any journal. */
export const EntryId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("EntryId"))
export type EntryId = typeof EntryId.Type

/** Something a tool result discovered, e.g. a record the next turn may cite. */
export const Subject = Schema.Struct({
  kind: Schema.Trimmed.check(Schema.isNonEmpty()),
  id: Schema.Trimmed.check(Schema.isNonEmpty()),
  label: Schema.OptionFromNullOr(Schema.String),
  data: Schema.OptionFromNullOr(Schema.Unknown),
})
export type Subject = typeof Subject.Type

/** A file or image a tool result carries, kept by reference (never inlined in the log). */
export const ArtifactRef = Schema.Struct({
  id: Schema.Trimmed.check(Schema.isNonEmpty()),
  kind: Schema.Literals(["image", "file"]),
  mediaType: Schema.Trimmed.check(Schema.isNonEmpty()),
  url: Schema.String,
  alt: Schema.OptionFromNullOr(Schema.String),
})
export type ArtifactRef = typeof ArtifactRef.Type

export const CompactionAction = Schema.Union(
  /** Older tool results shown through their compact views (texts align with entries). */
  [Schema.TaggedStruct("CompactViews", { entries: Schema.Array(EntryId), texts: Schema.Array(Schema.String) }),
  /** One large result replaced by a preview; the full value stays resolvable. */
  Schema.TaggedStruct("Spill", { entry: EntryId, preview: Schema.String }),
  /** Whole turns up to `throughTurn` replaced by a ledger. */
  Schema.TaggedStruct("DropTurns", { throughTurn: Schema.Int, ledger: Schema.String }),
  /** Everything before `keepFromTurn` replaced by a summary. */
  Schema.TaggedStruct("Summarize", { keepFromTurn: Schema.Int, summary: Schema.String })],
)
export type CompactionAction = typeof CompactionAction.Type

export const ActivationSource = Schema.Literals(["always", "matcher", "load_skill", "host"])
export type ActivationSource = typeof ActivationSource.Type

export const LogBody = Schema.Union(
  [Schema.TaggedStruct("SystemPrepared", {
    fingerprint: Schema.String,
    text: Schema.String,
    sections: Schema.Array(Schema.Struct({ id: Schema.String, version: Schema.String, fingerprint: Schema.String })),
  }),
  /**
   * The user's message, stored as plain text under its original key
   * `prompt`: existing logs decode unchanged and an entry's canonical bytes
   * (and so every fingerprint and cache key) stay the same.
   */
  Schema.TaggedStruct("TurnStarted", { userMessage: UserMessageFromString }).pipe(
    Schema.encodeKeys({ userMessage: "prompt" }),
  ),
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
    artifacts: Schema.Array(ArtifactRef),
    /** Pinned results survive every compaction verbatim. */
    pinned: Schema.Boolean,
  }),
  /**
   * A tool-specific digest of one result (see `DigestDefinition`), recorded
   * with its replacement text so replays never recompute it. Independent of
   * the strategy: any strategy that renders with `digests` applies it.
   */
  Schema.TaggedStruct("ToolDigest", {
    entry: EntryId,
    version: Schema.String,
    mode: Schema.Literals(["select", "summarize"]),
    keep: Schema.Array(Schema.String),
    text: Schema.String,
    digester: Schema.String,
    trigger: Schema.Literals(["write", "compaction"]),
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
    outcome: Schema.Literals(["completed", "partial", "failed"]),
    reply: Schema.OptionFromNullOr(Schema.String),
  })],
)
export type LogBody = typeof LogBody.Type

export const LogEntry = Schema.Struct({
  id: EntryId,
  runId: Schema.String,
  turn: Schema.Int,
  step: Schema.Int,
  at: Schema.Number,
  body: LogBody,
})
export type LogEntry = typeof LogEntry.Type

/** The model-visible rebuild of the log for one request. */
export const BuiltContext = Schema.Struct({
  messages: Schema.Array(AgentMessage),
  fingerprint: Schema.String,
  estimatedTokens: Schema.Int,
  compactions: Schema.Array(EntryId),
  /** The last entry folded: what a rebuild must stop at. */
  through: Schema.OptionFromNullOr(EntryId),
})
export type BuiltContext = typeof BuiltContext.Type
