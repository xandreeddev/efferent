import type { IdiomRule } from "../idiomGate.js"
import { brandedIdFields } from "./brandedIdFields.js"
import { matchOverTagSwitch } from "./matchOverTagSwitch.js"
import { noAsAny } from "./noAsAny.js"
import { noLet } from "./noLet.js"
import { noNullableReturn } from "./noNullableReturn.js"
import { noTryCatch } from "./noTryCatch.js"

/** Every built-in idiom rule — configs pick from these by `RuleId`. */
export const builtinRules: ReadonlyArray<IdiomRule> = [
  noTryCatch,
  noLet,
  noNullableReturn,
  matchOverTagSwitch,
  noAsAny,
  brandedIdFields,
]

export { brandedIdFields, matchOverTagSwitch, noAsAny, noLet, noNullableReturn, noTryCatch }
