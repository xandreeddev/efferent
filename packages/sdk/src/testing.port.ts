import { Context } from "effect"
import type { Ref } from "effect"

/** A per-turn host service for the agent tests: built by the turn's layer, read by use, tools and subscriptions. */
export class Tally extends Context.Service<Tally, { readonly runId: string; readonly seen: Ref.Ref<ReadonlyArray<string>> }>()("test/Tally") {}

/** A service a turn-dependent plugin provides in the agent tests, read by the host's layer. */
export class Stamp extends Context.Service<Stamp, { readonly label: string }>()("test/Stamp") {}

/** A process-lifetime host service for the agent tests: given to `Agent.define` in `services`, read by a tool and by `use`. */
export class Greeter extends Context.Service<Greeter, { readonly greet: (name: string) => string }>()("test/Greeter") {}

/** A host service no agent in the tests is given, so a turn that reads it still requires it. */
export class Unlisted extends Context.Service<Unlisted, { readonly label: string }>()("test/Unlisted") {}
