import { Schema } from "effect"
import { storedEvent } from "@xandreed/core"

/**
 * What a tool asks a person to approve (ADR 0012). `action` names the kind of thing, in the tool's own words and the
 * same every time (`"notes.forget"`): a standing approval covers an action. `detail` says what this one call would
 * do, for the person to read (`"Forget all 3 notes."`). A tool builds the detail from what the model sent, so
 * `approve` cuts one longer than `DETAIL_LIMIT` and says how much it cut; an action is the tool's own word, and one
 * over 200 characters is its mistake.
 *
 * @public
 */
export const ApprovalRequest = Schema.Struct({
  action: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  detail: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
})
export type ApprovalRequest = typeof ApprovalRequest.Type

/**
 * The most characters of a request's detail a person is asked to read, and a record keeps.
 *
 * @public
 */
export const DETAIL_LIMIT = 2000

/**
 * What was answered: yes for this once (`Approved`); yes for this action from now on, in this conversation
 * (`ApprovedAlways`); no (`Refused`); or yes by the host's own policy, with nobody asked (`Allowed`).
 *
 * @public
 */
export const Decision = Schema.Union([
  Schema.TaggedStruct("Approved", {}),
  Schema.TaggedStruct("ApprovedAlways", {}),
  Schema.TaggedStruct("Refused", {}),
  Schema.TaggedStruct("Allowed", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type Decision = typeof Decision.Type

/**
 * The data of `plugin.approval.decided`: what was asked, and the answer.
 *
 * @public
 */
export const DecidedData = Schema.Struct({ action: ApprovalRequest.fields.action, detail: ApprovalRequest.fields.detail, decision: Decision })
export type DecidedData = typeof DecidedData.Type

/**
 * `plugin.approval.decided`: an approval was asked for and answered. Stored in the turn that asked, tagged `trace`:
 * it bears no message, so no memory sends it. A standing approval is this record with `ApprovedAlways`
 * (`grantsOf`). A reader that does not know it may skip it.
 *
 * @public
 */
export const decidedEvent = storedEvent("approval", "decided", { data: DecidedData, skippable: true, tags: ["trace"] })

/**
 * What the model reads as the result of a call that was not approved. It names no detail: the call it answers says
 * what was asked.
 *
 * @public
 */
export const APPROVAL_REFUSED = "The user did not approve this action, so it was not done. Do not try it again unless the user asks for it."

/**
 * What `approve` fails with: the refusal's text, and nothing else. A tool whose failure is text
 * (`failure: Schema.String`) takes it as it is.
 *
 * @public
 */
export type ApprovalRefusal = typeof APPROVAL_REFUSED
