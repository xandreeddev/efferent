import { Schema } from "effect"
import { EvalId, Version } from "./identity.entity.js"
import { Suite } from "./suite.entity.js"
import { Grader } from "./grader.entity.js"

/** The subject of a calibration is a grader, never the application model. */
export const Calibration = Schema.Struct({ id: EvalId, version: Version, grader: Grader, suite: Suite })
export type Calibration = typeof Calibration.Type
