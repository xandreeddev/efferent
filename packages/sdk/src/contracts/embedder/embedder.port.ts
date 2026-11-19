import { Context } from "effect"
import type { Effect } from "effect"
import type { EmbedAs, EmbedFailed, Vector } from "./embedder.entity.js"

/**
 * An embedder (ADR 0021): it turns texts into vectors, so that texts can be found by meaning. The host provides it: a
 * model run in the page or the process, a service reached over the network, or a test's recorded vectors
 * (`recordedEmbedder`).
 *
 * - `model`: the name of what makes the vectors. Vectors are kept under it, and vectors of two models are never
 *   compared: an index keys each vector by the model and the text, so another model's are embedded again.
 * - `embed(texts, as)`: one vector per text, in the order given, each nearly the one that text gives alone (an 8-bit model
 *   scales its numbers for each batch, so a vector made among others may differ a little, never in direction), all of one
 *   length, as a question (`query`) or as a text kept to be found (`passage`). No texts give no vectors.
 *
 * A text it cannot embed, or a model or service that fails, fails the call with `EmbedFailed`, in words: no vector
 * of that call is made. `embedderConformance` is the contract as runnable checks.
 *
 * @public
 */
export class Embedder extends Context.Service<Embedder, {
  readonly model: string
  readonly embed: (texts: ReadonlyArray<string>, as: EmbedAs) => Effect.Effect<ReadonlyArray<Vector>, EmbedFailed>
}>()("@xandreed/sdk/kernel/Embedder") {}
