import { FiberRef, GlobalValue, Option } from "effect"
import type { ModelCallPolicy } from "../domain/model-call-policy.entity.js"

export const CurrentModelCallPolicy = GlobalValue.globalValue(
  "@xandreed/engine/CurrentModelCallPolicy",
  () => FiberRef.unsafeMake<Option.Option<ModelCallPolicy>>(Option.none()),
)

/**
 * Whether the CURRENT model call may legitimately return an empty response.
 *
 * An HTTP-200-but-empty body on a run's FIRST call is a provider-outage
 * signature and must stay hard-rejected (it would fake-complete the turn).
 * But once the run has executed a tool call, a following empty response is
 * how models say "I'm done" — rejecting it sends the call into the patient
 * outage ladder, which parks the turn until a deadline kills it (observed
 * live: math turns riding 120s budgets, ui composers riding 55s soft
 * deadlines, for work that finished in seconds).
 *
 * The LOOP sets this once the run has tool calls; adapters' empty-response
 * rejection consults it at call time. A FiberRef, not a port: ambient call
 * metadata, exactly like {@link CurrentModelCallPolicy}.
 */
export const CurrentEmptyResponseTolerance = GlobalValue.globalValue(
  "@xandreed/engine/CurrentEmptyResponseTolerance",
  () => FiberRef.unsafeMake<boolean>(false),
)
