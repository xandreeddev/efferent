import { Context, Data, type Effect } from "effect"
import type {
  ConversationId,
  ConversationMessage,
} from "../domain/Conversation.js"

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
    readonly append: (
      id: ConversationId,
      msg: ConversationMessage,
    ) => Effect.Effect<void, ConversationStoreError | ConversationNotFound>
    readonly list: (
      id: ConversationId,
    ) => Effect.Effect<
      ReadonlyArray<ConversationMessage>,
      ConversationStoreError
    >
  }
>() {}
