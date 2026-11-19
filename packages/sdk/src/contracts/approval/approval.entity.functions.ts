import { Effect, Option, Predicate, Schema } from "effect"
import { dataOf, stored } from "@xandreed/core"
import type { OpenSession, StoredDraft, StoredEvent } from "@xandreed/core"
import { CurrentTurn } from "../turn/current-turn.port.js"
import type { RunningTurn } from "../turn/current-turn.port.js"
import { runningTurn } from "../turn/running-turn.entity.functions.js"
import { APPROVAL_REFUSED, ApprovalRequest, decidedEvent, Decision, DETAIL_LIMIT } from "./approval.entity.js"
import type { ApprovalRefusal } from "./approval.entity.js"
import { Approval } from "./approval.port.js"

/** `plugin.approval.decided`: what was asked and the answer, for the turn that asked. */
export const decided = (request: ApprovalRequest, decision: Decision): StoredDraft =>
  stored(decidedEvent, { action: request.action, detail: request.detail, decision })

/**
 * The actions approved for good in a journal: each action of a `plugin.approval.decided` record whose answer was
 * `ApprovedAlways`, once, in the order they were first granted. A pure fold: a standing approval is nothing but
 * its record, so it is there after a restart and gone in another conversation.
 *
 * @public
 */
export const grantsOf = (journal: ReadonlyArray<StoredEvent>): ReadonlyArray<string> =>
  Array.from(new Set(journal.flatMap((event) => Option.match(dataOf(decidedEvent, event), {
    onNone: () => [],
    onSome: (data) => (data.decision._tag === "ApprovedAlways" ? [data.action] : []),
  }))))

const requested = Schema.decodeUnknownOption(ApprovalRequest)

/** What a tool reads, as its failed result, when the request it built is none. */
const NO_REQUEST = "approve needs an action, a text of 1 to 200 characters, and a detail that is not empty: approve({ action: \"notes.forget\", detail: \"Forget all 3 notes.\" })"

/**
 * A request with its detail cut to what a person is asked to read: a detail over `DETAIL_LIMIT` characters keeps its
 * start and says how many characters were left out. The detail is built from what the model sent, so its length is
 * not the tool's to promise. Anything that is not a request with a text for a detail is given back as it is.
 */
const clipped = (request: unknown): unknown => {
  if (!Predicate.hasProperty(request, "detail") || typeof request.detail !== "string" || request.detail.length <= DETAIL_LIMIT) return request
  const kept = DETAIL_LIMIT - 40
  const end = (request.detail.charCodeAt(kept - 1) & 0xfc00) === 0xd800 ? kept - 1 : kept
  return { ...request, detail: `${request.detail.slice(0, end)} [… ${request.detail.length - end} characters clipped]` }
}
const answer = Schema.decodeUnknownOption(Decision)

/** A refusal: the failure a handler's effect ends with, whose text the model reads as the call's result. */
const refused: Effect.Effect<never, ApprovalRefusal> = Effect.fail(APPROVAL_REFUSED)

/** The rule, over the turn it is asked in. */
const approveWith: (turn: RunningTurn, request: ApprovalRequest) => Effect.Effect<void, ApprovalRefusal, Approval> = Effect.fnUntraced(function* (turn, request) {
  const approval = yield* Approval
  // A request that names no action or says nothing is the tool's mistake: said as one, and nothing asked.
  const asked = yield* Option.match(requested(clipped(request)), {
    onNone: () => Effect.die(new Error(NO_REQUEST)),
    onSome: (valid) => Effect.succeed(valid),
  })
  // A standing approval is a record of this journal: nothing is asked, and nothing more stored.
  if (grantsOf(yield* turn.journal).includes(asked.action)) return
  // An answer that is no decision approves nothing, and is no one's decision: nothing is stored.
  const decision = answer(yield* approval.ask(asked))
  if (Option.isNone(decision)) return yield* refused
  yield* turn.append(decided(asked, decision.value))
  if (decision.value._tag === "Refused") return yield* refused
})

/**
 * Ask before acting (ADR 0012): one line at the start of a tool's handler, `yield* approve({ action, detail })`.
 * A standing approval of the action in this conversation's journal answers it, with nothing asked. Otherwise the
 * host's `Approval` is asked, and its answer stored in the turn as `plugin.approval.decided`. A refusal fails
 * with the text the model reads as the call's result (`APPROVAL_REFUSED`), so what follows in the handler does
 * not run. An answer that is no decision is a refusal, and nothing is stored. The tool declares what this needs:
 * `dependencies: [Approval, CurrentTurn]`.
 *
 * @public
 */
export const approve: (request: ApprovalRequest) => Effect.Effect<void, ApprovalRefusal, Approval | CurrentTurn> = Effect.fn("approval.approve")(function* (request) {
  return yield* approveWith(yield* CurrentTurn, request)
})

/**
 * `approve`, for a loop that holds the open session and asks before it runs a call, whatever the tool: the same
 * rules and the same record. A refusal fails with the same text, which the loop stores as the call's result
 * (`toolResult(call, refusal, true)`): a call left with no result is not sent again, and the model would never
 * read that it was refused.
 *
 * @public
 */
export const approveIn: (session: OpenSession, request: ApprovalRequest) => Effect.Effect<void, ApprovalRefusal, Approval> = Effect.fn("approval.approve_in")(function* (session, request) {
  return yield* approveWith(runningTurn(session), request)
})
