import { Schema } from "effect"
import { EvalId, Version } from "./identity.entity.js"

/** Action payloads belong to an application codec; the runner knows only ordering. */
export const Journey = Schema.Struct({
  id: EvalId, version: Version, fixture: Schema.Unknown,
  actions: Schema.Array(Schema.Struct({ id: EvalId, action: Schema.Unknown })).check(Schema.isMinLength(1)),
})
export type Journey = typeof Journey.Type
