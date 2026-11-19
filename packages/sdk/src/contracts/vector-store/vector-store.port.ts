import { Context } from "effect"
import type { Effect } from "effect"
import type { Vector } from "../embedder/embedder.entity.js"
import type { Scored, SearchOptions, VectorEntry, VectorKey, VectorsRefused, VectorsUnavailable } from "./vector-store.entity.js"

/**
 * A store of vectors (ADR 0021): an index of the journal, found by meaning, never a store of truth. The host provides
 * it: in memory for a page and a test (`inMemoryVectors`), a database later. What it holds can be lost and is made
 * again from the journal. Its keys are the caller's, made from the embedder's model and the text embedded (never an id, which belongs to one journal), and its vectors
 * are of one length.
 *
 * - `put(entries)`: keep each vector under its key; a key put again is replaced. A put is whole or nothing: one it
 *   refuses (`VectorsRefused`: a key that is no key, numbers that are no vector, a vector of another length than
 *   the store's) keeps none of its entries. The store's length is that of the first vector it keeps.
 * - `search(vector, { limit, among? })`: the keys whose vectors are most alike to `vector` by cosine, best first,
 *   keys of one score by code unit, at most `limit` (a whole number of at least 1). Given `among`, only its keys may
 *   be found: a key in it that is not stored is passed over, and the result still holds `limit` keys when that many
 *   of `among` are stored. An empty store finds nothing; a vector of another length than the store's, or a limit
 *   that is none, is refused (`VectorsRefused`).
 * - `has(keys)`: those of `keys` that are stored, in the order given, each once, so a caller embeds only what is
 *   missing.
 *
 * A medium that fails fails the call with `VectorsUnavailable`, a defect of the caller's call (as `FilesUnavailable`
 * is in the files contract). `vectorStoreConformance` is the contract as runnable checks.
 *
 * @public
 */
export class VectorStore extends Context.Service<VectorStore, {
  readonly put: (entries: ReadonlyArray<VectorEntry>) => Effect.Effect<void, VectorsRefused | VectorsUnavailable>
  readonly search: (vector: Vector, options: SearchOptions) => Effect.Effect<ReadonlyArray<Scored>, VectorsRefused | VectorsUnavailable>
  readonly has: (keys: ReadonlyArray<VectorKey>) => Effect.Effect<ReadonlyArray<VectorKey>, VectorsUnavailable>
}>()("@xandreed/sdk/VectorStore") {}
