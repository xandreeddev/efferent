import { Context, Data, type Effect } from "effect"
import type {
  AgentMessage,
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
  readonly id: string
}> {}

export class ConversationStore extends Context.Tag(
  "@agent/core/ConversationStore",
)<
  ConversationStore,
  {
    readonly create: () => Effect.Effect<
      ConversationId,
      ConversationStoreError
    >
    /**
     * Idempotent: create the conversation if it doesn't exist. Used by
     * the web route to materialise the conversation referenced by the
     * client's cookie before any messages are appended.
     */
    readonly ensure: (
      id: ConversationId,
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
  }
>() {}
