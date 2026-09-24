import { Effect } from "effect"
import type { AssessmentError } from "../assessment.entity.js"

export type Preference = "A" | "B" | "tie"
const reversed = (winner: Preference): Preference => winner === "tie" ? "tie" : winner === "A" ? "B" : "A"

/** Both anonymous orders are retained. Inconsistency is never converted to a tie. */
export const assessBothOrders = <I, R>(a: I, b: I, judge: (a: I, b: I) => Effect.Effect<Preference, AssessmentError, R>) => Effect.gen(function* () {
  const forward = yield* judge(a, b)
  const reverse = yield* judge(b, a)
  return { forward, reverse, consistent: forward === reversed(reverse) }
})
