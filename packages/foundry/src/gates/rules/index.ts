import { brandedIdFields } from "./brandedIdFields.js"
import { matchOverTagSwitch } from "./matchOverTagSwitch.js"
import { noAsAny } from "./noAsAny.js"
import { noEmptyCatch } from "./noEmptyCatch.js"
import { noLet } from "./noLet.js"
import { noLoopStatements } from "./noLoopStatements.js"
import { noNullableReturn } from "./noNullableReturn.js"
import { noParallelInterface } from "./noParallelInterface.js"
import { noSkippedTests } from "./noSkippedTests.js"
import { noTryCatch } from "./noTryCatch.js"

/** The shipped rules are a LIBRARY organized as packs (`packs.js`) — config
 *  resolution never falls back to them implicitly; a config module names
 *  what it wants via its `rulePacks`/`customRules` exports. */
export * from "./custom.js"
export * from "./packs.js"

export {
  brandedIdFields,
  matchOverTagSwitch,
  noAsAny,
  noEmptyCatch,
  noLet,
  noLoopStatements,
  noNullableReturn,
  noParallelInterface,
  noSkippedTests,
  noTryCatch,
}
