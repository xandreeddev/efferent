import { Schema } from "effect"

export const BlockStatus = Schema.Literals(["pending", "running", "complete", "failed", "cancelled"])
export type BlockStatus = typeof BlockStatus.Type
export const ComposerMode = Schema.Literals(["insert", "normal"])
export type ComposerMode = typeof ComposerMode.Type

/** Presentation values are rebuilt from the journal; they are never persisted. */
export const TranscriptBlock = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["user", "assistant", "tool", "notice"]),
  text: Schema.String,
  detail: Schema.String,
  status: BlockStatus,
  runId: Schema.optional(Schema.String),
  turnIndex: Schema.optional(Schema.Number),
  sourceSession: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  category: Schema.optional(Schema.Literals(["read", "edit", "check", "handoff", "other"])),
  durationMs: Schema.optional(Schema.Number),
  summary: Schema.optional(Schema.String),
  members: Schema.optional(Schema.Array(Schema.String)),
})
export type TranscriptBlock = typeof TranscriptBlock.Type

export const JournalTurn = Schema.Struct({ runId: Schema.String, sourceSession: Schema.String, turn: Schema.Number })
export type JournalTurn = typeof JournalTurn.Type

export const Transcript = Schema.Struct({
  blocks: Schema.Array(TranscriptBlock),
  status: Schema.String,
  runId: Schema.String,
  tokens: Schema.Number,
  outputTokens: Schema.Number,
  totalTokens: Schema.Number,
  seq: Schema.Number,
  startedAt: Schema.Number,
  journalPositions: Schema.Record(Schema.String, Schema.Number),
  journalTurns: Schema.Record(Schema.String, JournalTurn),
})
export type Transcript = typeof Transcript.Type

/** A bounded inspector row. Commands provide values, never terminal markup. */
export const InspectorRow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  detail: Schema.String,
  text: Schema.String,
  status: Schema.optional(BlockStatus),
})
export type InspectorRow = typeof InspectorRow.Type
