import { Schema } from "effect"
import { EvalId, Fingerprints } from "./identity.entity.js"

/** @public */
export const Candidate = Schema.Struct({ id: EvalId, configuration: Schema.Unknown, fingerprints: Fingerprints })
export type Candidate = typeof Candidate.Type
