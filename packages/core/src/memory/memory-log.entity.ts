import { Schema, SchemaTransformation } from "effect"
import { ToolResultInterception } from "../domain/tool-interceptor.entity.js"
import type { Option } from "effect"
import { Media, MediaSlot } from "../domain/media.entity.js"
import { AgentMessage, ToolCallId } from "../domain/message.entity.js"
import { InboxItemId } from "../session/sessions.entity.js"
import { RunId, RunKey, RunOrdinal } from "../domain/run.entity.js"
import { TurnOutcomeKind } from "../domain/turn-vocabulary.entity.js"
import { DecisionId } from "../decision-record.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"

/**
 * The conversation memory log — the single source every model request is
 * rebuilt from ("model-visible ⟺ logged"). Entries are appended, never edited:
 * a compaction is itself an entry that carries the replacement bytes, so a
 * replay reproduces exactly what the model saw.
 */

/** `<runId>:<index within the run>` — assigned by memory, independent of any journal. */
export const EntryId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("EntryId"))
export type EntryId = typeof EntryId.Type

/** A subject's id within its kind (a file's path for `file`), as a tool's view names it. */
export const SubjectId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("SubjectId"))
export type SubjectId = typeof SubjectId.Type

/** Something a tool result discovered, e.g. a record the next turn may cite. */
export const Subject = Schema.Struct({
  kind: Schema.Trimmed.check(Schema.isNonEmpty()),
  id: SubjectId,
  label: Schema.OptionFromNullOr(Schema.String),
  data: Schema.OptionFromNullOr(Schema.Unknown),
})
export type Subject = typeof Subject.Type

/**
 * A file or image's id, as the tool result that points to it names it.
 *
 * @public
 */
export const ArtifactId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("ArtifactId"))
export type ArtifactId = typeof ArtifactId.Type

/**
 * A file or image a tool result points to by URL: the log keeps the
 * reference, never the content, and every render shows it as a reference
 * line, whatever the media mode. An image the model is to see is a `Media`
 * value, stored inline.
 *
 * @public
 */
export const ArtifactRef = Schema.Struct({
  id: ArtifactId,
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
  Schema.TaggedStruct("Summarize", { keepFromTurn: Schema.Int, summary: Schema.String }),
  /**
   * The images of these entries (a user's attachments, a tool result's
   * images) shown as label lines from now on, because a provider refused a
   * request that sent them; `reason` is what it said. Recorded by the turn
   * (`StepRequest.onMediaRejected`), it applies whatever strategy renders.
   */
  Schema.TaggedStruct("OmitMedia", { entries: Schema.Array(EntryId), reason: Schema.String })],
).pipe(Schema.toTaggedUnion("_tag"))
export type CompactionAction = typeof CompactionAction.Type

export const ActivationSource = Schema.Literals(["always", "matcher", "load_skill", "host"])
export type ActivationSource = typeof ActivationSource.Type

/**
 * A prompt section's id (`PromptSection.id`), or a turn-context entry's
 * (`TurnContextEntry.id`), as the log stores it, with no checks.
 *
 * @public
 */
export const SectionId = Schema.String.pipe(Schema.brand("SectionId"))
export type SectionId = typeof SectionId.Type

/**
 * A turn-context message the model sees this turn: a turn-tier prompt
 * section, or an entry the host adds (`TurnMemory.context`).
 *
 * @public
 */
export const TurnContextBody = Schema.TaggedStruct("TurnContext", { sectionId: SectionId, version: Schema.String, text: Schema.String })
export type TurnContextBody = typeof TurnContextBody.Type

/** A TurnStarted body as stored: the text under `prompt`, the images (when there are some) under `attachments`. */
const StoredTurnStarted = Schema.Struct({
  _tag: Schema.Literal("TurnStarted"),
  prompt: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(Schema.toEncoded(Media))),
})

export const LogBody = Schema.Union(
  [Schema.TaggedStruct("SystemPrepared", {
    fingerprint: Schema.String,
    text: Schema.String,
    sections: Schema.Array(Schema.Struct({ id: SectionId, version: Schema.String, fingerprint: Schema.String })),
  }),
  /**
   * The user's message, stored with its text under the original key
   * `prompt` and its images, only when it has some, under `attachments`: a
   * text-only message is stored exactly as before, so existing logs decode
   * unchanged and an entry's canonical bytes (and so every fingerprint and
   * cache key) stay the same.
   */
  StoredTurnStarted.pipe(Schema.decodeTo(
    Schema.TaggedStruct("TurnStarted", { userMessage: UserMessage }),
    SchemaTransformation.transform({
      decode: ({ prompt, attachments }) => ({ _tag: "TurnStarted" as const, userMessage: attachments === undefined ? { text: prompt } : { text: prompt, attachments } }),
      encode: ({ userMessage }) => userMessage.attachments === undefined
        ? { _tag: "TurnStarted" as const, prompt: userMessage.text }
        : { _tag: "TurnStarted" as const, prompt: userMessage.text, attachments: userMessage.attachments },
    }),
  )),
  TurnContextBody,
  Schema.TaggedStruct("Message", {
    message: AgentMessage,
    run: Schema.optionalKey(RunOrdinal),
    /** The immutable queued input consumed with this exact user message. */
    inbox: Schema.optionalKey(InboxItemId),
  }).check(Schema.makeFilter((body) => body.inbox === undefined || body.message.role === "user" ? true : "an inbox message must have the user role")),
  Schema.TaggedStruct("ToolResult", {
    toolCallId: ToolCallId,
    run: Schema.optionalKey(RunOrdinal),
    toolName: Schema.String,
    isError: Schema.Boolean,
    /** Full fidelity: the tool's encoded result. */
    encoded: Schema.Unknown,
    /** Accepted interception metadata for this result; original assistant arguments are unchanged. */
    interception: Schema.optionalKey(ToolResultInterception),
    /** The exact text the model saw when the result was written. */
    view: Schema.String,
    viewVersion: Schema.String,
    subjects: Schema.Array(Subject),
    artifacts: Schema.Array(ArtifactRef),
    /** Pinned results survive every compaction verbatim. */
    pinned: Schema.Boolean,
    /**
     * The images the model is sent with the result, where they are in
     * `encoded` (each stored once, there), checked when the result was
     * written; only when there are some, so a result without images is
     * stored as before.
     */
    media: Schema.optionalKey(Schema.Array(MediaSlot)),
    /**
     * The lines `view` ends with for the images the result does not send (an
     * `[image unavailable: …]` line, or the label line of one past the
     * per-result caps); only when there are some. A result shown through
     * other text (a compaction's, a digest's, a spill's preview) shows them
     * after that text.
     */
    mediaNotes: Schema.optionalKey(Schema.Array(Schema.String)),
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
  /** The step policy's context for one step of one run of the turn (`run`; an entry written before runs were counted reads 0). */
  Schema.TaggedStruct("StepContext", { step: Schema.Int, run: RunKey, text: Schema.String }),
  Schema.TaggedStruct("ToolsActivated", {
    skills: Schema.Array(Schema.String),
    tools: Schema.Array(Schema.String),
    source: ActivationSource,
    decision: Schema.OptionFromNullOr(DecisionId),
  }),
  Schema.TaggedStruct("Compaction", { strategy: Schema.String, version: Schema.String, action: CompactionAction }),
  Schema.TaggedStruct("TurnEnded", {
    outcome: TurnOutcomeKind,
    reply: Schema.OptionFromNullOr(Schema.String),
  }),
  /** A tool result's view, recorded after its raw encoded value is durable. Contains no result or media bytes. */
  Schema.TaggedStruct("ToolPresentation", {
    entry: EntryId,
    view: Schema.String,
    viewVersion: Schema.String,
    subjects: Schema.Array(Subject),
    artifacts: Schema.Array(ArtifactRef),
    pinned: Schema.Boolean,
    media: Schema.Array(MediaSlot),
    mediaNotes: Schema.Array(Schema.String),
  })],
).pipe(Schema.toTaggedUnion("_tag"))
export type LogBody = typeof LogBody.Type

export const LogEntry = Schema.Struct({
  id: EntryId,
  runId: RunId,
  turn: Schema.Int,
  step: Schema.Int,
  at: Schema.Number,
  body: LogBody,
})
export type LogEntry = typeof LogEntry.Type

/**
 * The model-visible rebuild of the log for one request.
 *
 * @public
 */
export const BuiltContext = Schema.Struct({
  messages: Schema.Array(AgentMessage),
  /** The rendered prefix before the selected run's step-context tail; all messages when there is no tail. */
  stableMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fingerprint: Schema.String,
  estimatedTokens: Schema.Int,
  compactions: Schema.Array(EntryId),
  /** The last entry folded: what a rebuild must stop at. */
  through: Schema.OptionFromNullOr(EntryId),
}).check(Schema.makeFilter((context) => context.stableMessages <= context.messages.length || "stableMessages must not exceed the rendered message count"))
export type BuiltContext = typeof BuiltContext.Type

/**
 * What `MemoryReader.query` selects from a log (`queryLog`); `emptyQuery`
 * selects every entry.
 *
 * @public
 */
export interface LogQuery {
  readonly kinds: ReadonlyArray<LogBody["_tag"]>
  readonly turns: Option.Option<{ readonly from: number; readonly to: number }>
  readonly tool: Option.Option<string>
  readonly subject: Option.Option<{ readonly kind: string; readonly id: Option.Option<string> }>
  readonly text: Option.Option<string>
  readonly limit: Option.Option<number>
}
