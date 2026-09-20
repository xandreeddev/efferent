import { Context, Option, Schema } from "effect"
import type { Effect } from "effect"
import { AgentMessage, ConversationId } from "../domain/message.entity.js"
import type { Checkpoint } from "../domain/message.entity.js"

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
}) {}

/** How a run ENDED — persisted beside the trail so the database alone says
 *  whether the last run completed on its own or was stopped by the step cap
 *  or the degenerate-loop breaker (the loop's `agent_end` was in-memory only). */
export class RunOutcomeRecord extends Schema.Class<RunOutcomeRecord>("RunOutcomeRecord")({
  conversationId: ConversationId,
  /** Epoch millis. */
  at: Schema.Number,
  outcome: Schema.Literal("ok", "partial"),
  reason: Schema.Literal("completed", "step-cap", "degenerate-loop"),
}) {}

export class ConversationSummary extends Schema.Class<ConversationSummary>(
  "ConversationSummary",
)({
  id: ConversationId,
  createdAt: Schema.Number,
  firstPrompt: Schema.optionalWith(Schema.String, { as: "Option" }),
  title: Schema.optionalWith(Schema.String, { as: "Option" }),
  /** The latest recorded run outcome, when a run has finished in it. */
  lastOutcome: Schema.optionalWith(
    Schema.Struct({
      outcome: Schema.Literal("ok", "partial"),
      reason: Schema.Literal("completed", "step-cap", "degenerate-loop"),
    }),
    { as: "Option" },
  ),
}) {}

/** A persisted row WITH its durable position — what the active window is
 *  made of, so a loader never reconstructs positions by arithmetic (an
 *  undecodable row in between would shift every later one). */
export class StoredMessage extends Schema.Class<StoredMessage>("StoredMessage")({
  position: Schema.Int,
  message: AgentMessage,
}) {}

/**
 * The conversation persistence port. Positions are the durable identity:
 * `append` assigns a monotonic, immutable absolute position per conversation,
 * and UIs key their blocks on it so a live-streamed block and a later
 * re-projection of the same message reconcile instead of duplicating.
 *
 * A checkpoint FOLDS the history for loading purposes only: `list` always
 * returns every row; `listActive` returns the rows after the latest fold.
 * The loop prepends the fold's summary itself (domain logic stays here,
 * not in the adapter).
 */
export class ConversationStore extends Context.Tag("@xandreed/core/ConversationStore")<
  ConversationStore,
  {
    readonly create: (workspaceDir?: string) => Effect.Effect<ConversationId, StoreError>
    readonly append: (
      id: ConversationId,
      message: AgentMessage,
    ) => Effect.Effect<number, StoreError>
    /** One turn's rows land TOGETHER or not at all — an assistant tool call
     *  without its results is a row the next run cannot send. Returns the
     *  positions, aligned with the input. */
    readonly appendAll: (
      id: ConversationId,
      messages: ReadonlyArray<AgentMessage>,
    ) => Effect.Effect<ReadonlyArray<number>, StoreError>
    readonly list: (
      id: ConversationId,
    ) => Effect.Effect<ReadonlyArray<AgentMessage>, StoreError>
    /** The rows after the latest fold, each with its position. */
    readonly listActive: (
      id: ConversationId,
    ) => Effect.Effect<ReadonlyArray<StoredMessage>, StoreError>
    readonly checkpoint: (
      id: ConversationId,
      summary: string,
    ) => Effect.Effect<void, StoreError>
    /** A fold up to an EXPLICIT position (the within-run compaction seam):
     *  rows at or before it are covered by the summary; `listActive` returns
     *  only the rows after. `checkpoint` folds everything appended so far. */
    readonly checkpointAt: (
      id: ConversationId,
      summary: string,
      messagePosition: number,
    ) => Effect.Effect<void, StoreError>
    readonly latestCheckpoint: (
      id: ConversationId,
    ) => Effect.Effect<Option.Option<Checkpoint>, StoreError>
    readonly setTitle: (
      id: ConversationId,
      title: string,
    ) => Effect.Effect<void, StoreError>
    /** Record how a run ended (appended; the latest is the conversation's). */
    readonly recordOutcome: (
      id: ConversationId,
      outcome: RunOutcomeRecord["outcome"],
      reason: RunOutcomeRecord["reason"],
    ) => Effect.Effect<void, StoreError>
    readonly latestOutcome: (
      id: ConversationId,
    ) => Effect.Effect<Option.Option<RunOutcomeRecord>, StoreError>
    readonly listByWorkspace: (
      workspaceDir: string,
    ) => Effect.Effect<ReadonlyArray<ConversationSummary>, StoreError>
    /** BRANCH: copy rows [0..upToPosition] (default: all) into a NEW
     *  conversation in the same workspace, along with the latest covered
     *  checkpoint — the original stays untouched; the fork continues
     *  independently (git-branch semantics over the trail). */
    readonly fork: (
      id: ConversationId,
      upToPosition?: number,
    ) => Effect.Effect<ConversationId, StoreError>
    /** RETENTION: delete whole conversations created before `beforeEpochMs`
     *  (messages + checkpoints + the conversation row) and reclaim the
     *  space. Nothing calls this automatically — deletion is a deliberate,
     *  human-initiated act on an otherwise append-only store. Returns the
     *  number of conversations removed. */
    readonly prune: (beforeEpochMs: number) => Effect.Effect<number, StoreError>
  }
>() {}
