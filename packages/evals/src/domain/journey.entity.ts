import { Schema } from "effect"
import { EvalId, Version } from "./identity.entity.js"

/**
 * A fixture and an ordered list of actions (`docs/composable-evaluations.md`, "Journeys"). Action payloads belong to
 * an application codec; the runner knows only ordering.
 *
 * @public
 */
export const Journey = Schema.Struct({
  id: EvalId, version: Version, fixture: Schema.Unknown,
  actions: Schema.Array(Schema.Struct({ id: EvalId, action: Schema.Unknown })).check(Schema.isMinLength(1)),
})
export type Journey = typeof Journey.Type
