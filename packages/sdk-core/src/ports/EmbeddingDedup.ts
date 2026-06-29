import { Context, Data, Effect } from "effect"

/** Computing embeddings for semantic deduplication failed. */
export class EmbeddingDedupError extends Data.TaggedError("EmbeddingDedupError")<{
  readonly message: string
}>() {}

export interface EmbeddingDedup {
  /**
   * Compute an embedding vector for the given text.
   * Returns a normalized float array (length depends on the model).
   */
  readonly embed: (
    text: string,
  ) => Effect.Effect<ReadonlyArray<number>, EmbeddingDedupError>

  /**
   * Check if `candidateText` is semantically similar to any of the existing
   * texts (above `threshold`). Returns the most similar match if so.
   * `threshold` is cosine similarity, default 0.92.
   */
  readonly findDuplicate: (args: {
    readonly candidateText: string
    readonly existingTexts: ReadonlyArray<string>
    readonly threshold?: number
  }) => Effect.Effect<
    | { readonly isDuplicate: true; readonly matchedText: string; readonly similarity: number }
    | { readonly isDuplicate: false },
    EmbeddingDedupError
  >
}

export class EmbeddingDedup extends Context.Tag("@xandreed/sdk-core/EmbeddingDedup")<
  EmbeddingDedup,
  EmbeddingDedup
>() {}

/** No-op implementation useful as a default when deduplication is disabled. */
export const NoOpEmbeddingDedup: EmbeddingDedup = {
  embed: () => Effect.succeed([]),
  findDuplicate: () => Effect.succeed({ isDuplicate: false }),
}
