import { Schema } from "effect"
import { EvalId, Version, Fingerprints } from "./identity.entity.js"

export const Runnable = Schema.Struct({ id: EvalId, version: Version, description: Schema.String, fingerprints: Fingerprints })
export type Runnable = typeof Runnable.Type
