import { Context, Option, Schema } from "effect"
import type { Effect } from "effect"
import { ConversationId } from "../domain/Message.js"
import type { AgentMessage, Checkpoint } from "../domain/Message.js"

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
}) {}

export class ConversationSummary extends Schema.Class<ConversationSummary>(
  "ConversationSummary",
)({
  id: ConversationId,
  createdAt: Schema.Number,
  firstPrompt: Schema.optionalWith(Schema.String, { as: "Option" }),
  title: Schema.optionalWith(Schema.String, { as: "Option" }),
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
export class ConversationStore extends Context.Tag("@xandreed/engine/ConversationStore")<
  ConversationStore,
  {
    readonly create: (workspaceDir?: string) => Effect.Effect<ConversationId, StoreError>
    readonly append: (
      id: ConversationId,
      message: AgentMessage,
    ) => Effect.Effect<number, StoreError>
    readonly list: (
      id: ConversationId,
    ) => Effect.Effect<ReadonlyArray<AgentMessage>, StoreError>
    readonly listActive: (
      id: ConversationId,
    ) => Effect.Effect<ReadonlyArray<AgentMessage>, StoreError>
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
    readonly listByWorkspace: (
      workspaceDir: string,
    ) => Effect.Effect<ReadonlyArray<ConversationSummary>, StoreError>
  }
>() {}
