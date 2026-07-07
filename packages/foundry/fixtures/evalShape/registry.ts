import { suite as emptyScorers } from "./emptyScorers.eval.js"
import { suite as noThreshold } from "./noThreshold.eval.js"
import { suite as registered } from "./registered.eval.js"

export const SUITES = [emptyScorers, noThreshold, registered]
