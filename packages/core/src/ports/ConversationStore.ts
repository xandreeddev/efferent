import { Context, Data, type Effect } from "effect"
import type {
  AgentMessage,
  Checkpoint,
  ConversationId,
} from "../entities/Conversation.js"

export class ConversationStoreError extends Data.TaggedError(
  "ConversationStoreError",
)<{
  readonly cause: unknown
  readonly message: string
}> {}

export class ConversationNotFound extends Data.TaggedError(
  "ConversationNotFound",
)<{
  readonly id: ConversationId
}> {}

export class ConversationStore extends Context.Tag(
  "@efferent/core/ConversationStore",
)<
  ConversationStore,
  {
    readonly create: (
      workspaceDir?: string,
    ) => Effect.Effect<ConversationId, ConversationStoreError>
    /**
     * Idempotent: create the conversation if it doesn't exist. Used by
     * the web route to materialise the conversation referenced by the
     * client's cookie before any messages are appended.
     */
    readonly ensure: (
      id: ConversationId,
      workspaceDir?: string,
    ) => Effect.Effect<void, ConversationStoreError>
    readonly append: (
      id: ConversationId,
      msg: AgentMessage,
    ) => Effect.Effect<void, ConversationStoreError | ConversationNotFound>
    readonly list: (
      id: ConversationId,
    ) => Effect.Effect<
      ReadonlyArray<AgentMessage>,
      ConversationStoreError
    >
    /**
     * Fold the conversation at its current head: record a checkpoint whose
     * `messagePosition` is the latest message position (computed atomically),
     * with `summary` as the handoff that replaces everything up to and
     * including that position for loading purposes. Original messages are
     * never modified — `list` still returns them; only `listActive` narrows.
     */
    readonly checkpoint: (
      id: ConversationId,
      summary: string,
    ) => Effect.Effect<void, ConversationStoreError>
    readonly getLatestCheckpoint: (
      id: ConversationId,
    ) => Effect.Effect<Checkpoint | undefined, ConversationStoreError>
    readonly listCheckpoints: (
      id: ConversationId,
    ) => Effect.Effect<ReadonlyArray<Checkpoint>, ConversationStoreError>
    /**
     * Messages the agent actually loads: only the **real** rows after the
     * latest checkpoint's position (or all rows if no checkpoint). Does NOT
     * include the handoff summary — `runAgent` prepends that (domain logic
     * stays in core). For browsing the full record, use `list`.
     */
    readonly listActive: (
      id: ConversationId,
    ) => Effect.Effect<ReadonlyArray<AgentMessage>, ConversationStoreError>
    /** Name the conversation (generated after its first exchange; shown in
     *  session lists instead of the raw first-prompt preview). */
    readonly setTitle: (
      id: ConversationId,
      title: string,
    ) => Effect.Effect<void, ConversationStoreError | ConversationNotFound>
    readonly listByWorkspace: (
      workspaceDir: string,
    ) => Effect.Effect<
      ReadonlyArray<{
        readonly id: ConversationId
        readonly createdAt: number
        /** Latest message timestamp (last activity), else `createdAt`. */
        readonly updatedAt: number
        /** Persisted message count (user + assistant + tool rows). */
        readonly messageCount: number
        readonly firstPrompt?: string
        readonly title?: string
      }>,
      ConversationStoreError
    >
  }
>() {}
