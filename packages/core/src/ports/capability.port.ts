import { Context } from "effect"
import type { Effect } from "effect"
import type { CapabilityCatalog, CapabilitySelection } from "../harness/capability.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"

export class Capabilities extends Context.Tag("efferent/Capabilities")<Capabilities, {
  readonly catalog: CapabilityCatalog
}>() {}
export class IntentMatcher extends Context.Tag("efferent/IntentMatcher")<IntentMatcher, {
  readonly match: (message: string, catalog: CapabilityCatalog) => Effect.Effect<CapabilitySelection, HarnessError>
}>() {}
