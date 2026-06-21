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
  "@xandreed/sdk-core/ConversationStore",
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
        readonly firstPrompt?: string
        readonly title?: string
        /** The fleet's pinned model (`"<provider>:<modelId>"`), if set — so a
         *  restarted daemon rebuilds each fleet on its own model. */
        readonly model?: string
      }>,
      ConversationStoreError
    >
    /** Pin a conversation's (fleet's) model — the per-fleet config that survives
     *  restart and shields a running fleet from a global-default change. */
    readonly setModel: (
      id: ConversationId,
      model: string,
    ) => Effect.Effect<void, ConversationStoreError | ConversationNotFound>
    /**
     * Mark a turn **in flight** for a session: the daemon sets this to the user
     * prompt when a turn starts and clears it on completion. A restarted daemon
     * reads non-null markers (via {@link listPending}) to auto-resume a turn
     * interrupted by a crash. Best-effort — a marker failure never breaks a run.
     */
    readonly markPending: (
      id: ConversationId,
      prompt: string,
    ) => Effect.Effect<void, ConversationStoreError | ConversationNotFound>
    /** Clear the in-flight marker for a session (on turn completion). */
    readonly clearPending: (
      id: ConversationId,
    ) => Effect.Effect<void, ConversationStoreError>
    /** Sessions in `workspaceDir` with an unfinished turn — the crash-recovery
     *  list a restarted daemon walks to auto-resume interrupted turns. */
    readonly listPending: (
      workspaceDir: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly id: ConversationId; readonly prompt: string }>,
      ConversationStoreError
    >
  }
>() {}
