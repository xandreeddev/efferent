import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { MediaHash, MediaStoreError } from "../domain/media-store.entity.js"

/**
 * Immutable blobs addressed by SHA-256 of decoded bytes, not media fingerprints
 * or occurrence labels. put accepts 1..MEDIA_LIMITS.imageBytes bytes, copies
 * before waiting and is idempotent. get returns an independent copy or None
 * for an absent hash; corrupt stored bytes fail rather than appearing absent.
 * Invalid inputs and backend failures are MediaStoreError values. Hashes name
 * content inside a trusted host store and grant no authorization by themselves.
 * mediaStoreConformance is the contract as runnable checks.
 * @public
 */
export class MediaStore extends Context.Service<MediaStore, {
  readonly put: (bytes: Uint8Array) => Effect.Effect<MediaHash, MediaStoreError>
  readonly get: (hash: MediaHash) => Effect.Effect<Option.Option<Uint8Array>, MediaStoreError>
}>()("@xandreed/core/MediaStore") {}
