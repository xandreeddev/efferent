import { Context } from "effect"
import type { Ref } from "effect"

/** A per-turn host service for the agent tests: built by the turn's layer, read by use, tools and subscriptions. */
export class Tally extends Context.Service<Tally, { readonly runId: string; readonly seen: Ref.Ref<ReadonlyArray<string>> }>()("test/Tally") {}
