import { Context } from "effect"
import type { Effect } from "effect"
import type { CurationFailed, CurationJob } from "./curator.entity.js"

/**
 * What keeps an agent's long-term memory asks a model through (ADR 0022): a prompt (`curationPrompt`, or
 * `reviewPrompt` for a second call) and the job it is for, to the model's reply as text, which `curationOf` reads.
 * No kernel plugin calls a model (ADR 0004): the host provides the curator, over the model it picked or any
 * other, with its own budget and tracing, as it provides a `Summarizer`.
 *
 * A reply is a result, whatever it says: one that is no JSON is the caller's to read and count. Only a call that
 * gave no reply fails, with `CurationFailed`. `curatorConformance` is the contract as runnable checks.
 *
 * @public
 */
export class Curator extends Context.Service<Curator, {
  /** The model's reply to `prompt`, as text that is not blank. */
  readonly curate: (input: { readonly prompt: string; readonly job: CurationJob }) => Effect.Effect<string, CurationFailed>
}>()("@xandreed/sdk/Curator") {}
