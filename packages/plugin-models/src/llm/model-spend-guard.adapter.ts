import { Cause, Effect, Match, Option } from "effect"
import type { HttpClientRequest } from "effect/http"
import { CurrentTurnRunId, formatModelSelection, HarnessError, reasonOf } from "@xandreed/core"
import type { HarnessCode, ModelCallUsage, ModelPrice, ModelSpend, SpendHold } from "@xandreed/core"
import { CurrentModelCallSelection } from "../ports/model-call-completion.port.js"
import { CurrentModelSpendGuard } from "../ports/model-spend-guard.port.js"
import { inputTokenBound, requestOutputCapOf, spendPriceOf, spendSettlementOf, worstCaseCost } from "./model-spend.entity.functions.js"
import type { SendReach } from "./model-spend.entity.js"

/** What one physical attempt reserved: the ledger, its hold and the price it settles at. */
export interface AttemptSpend {
  readonly ledger: ModelSpend["Service"]
  readonly hold: SpendHold
  readonly price: ModelPrice
}

const refused = (code: Extract<HarnessCode, "model.spend" | "model.unpriced">, message: string, cause?: unknown): HarnessError =>
  new HarnessError({ code, plugin: "@xandreed/plugin-models", message, ...(cause === undefined ? {} : { cause }) })

/** A request body's bytes, as its text and its size; none for a streamed or multipart body, which cannot be measured before it is sent. */
const measured = (request: HttpClientRequest.HttpClientRequest): Option.Option<{ readonly text: string; readonly bytes: number }> => Match.valueTags(request.body, {
  Empty: () => Option.some({ text: "", bytes: 0 }),
  Uint8Array: (body) => Option.some({ text: body.text ?? new TextDecoder().decode(body.body), bytes: body.body.byteLength }),
  Raw: (body) => typeof body.body === "string"
    ? Option.some({ text: body.body, bytes: new TextEncoder().encode(body.body).byteLength })
    : body.body instanceof ArrayBuffer || ArrayBuffer.isView(body.body)
      ? Option.some({ text: new TextDecoder().decode(body.body), bytes: body.body.byteLength })
      : Option.none(),
  FormData: () => Option.none(),
  Stream: () => Option.none(),
})

/**
 * Reserve a physical send's worst case in the spend guard's ledger, when
 * the models plugin's `spend` option is set: the request body's input
 * bound and its output cap (else `uncappedOutputTokens`), at the call's
 * model's price, for the current turn (`CurrentTurnRunId`) within the
 * option's caps. The caller runs it uninterruptibly, together with the
 * attempt that takes the hold, so no hold the ledger has taken is left
 * without an attempt to close it. A refusal fails as a `HarnessError`, a `TurnError` that
 * stops the call before anything is sent: `model.unpriced` for a model the
 * prices leave out, `model.spend` past a cap (its cause the ledger's
 * `ModelSpendExceeded`) or with the ledger unreachable.
 */
export const reserveSend = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest): Effect.fn.Return<Option.Option<AttemptSpend>, HarnessError> {
  const guard = yield* CurrentModelSpendGuard
  if (Option.isNone(guard)) return Option.none()
  const { ledger, options } = guard.value
  const selection = yield* CurrentModelCallSelection
  const price = spendPriceOf(options.prices, selection)
  if (Option.isNone(price)) {
    return yield* Effect.fail(refused("model.unpriced", Option.match(selection, {
      onNone: () => "the models plugin's spend guard refused a call that names no model: it has no price to cap its spend with",
      onSome: (model) => `the models plugin's spend guard has no price for ${formatModelSelection(model)}: add it to the spend option's prices`,
    })))
  }
  const body = measured(request)
  if (Option.isNone(body)) return yield* Effect.fail(refused("model.spend", "the models plugin's spend guard cannot measure a streamed or multipart request body before it is sent"))
  const outputTokens = Option.getOrElse(requestOutputCapOf(body.value.text), () => options.uncappedOutputTokens)
  const amount = worstCaseCost(inputTokenBound(body.value.bytes, options.inputBytesPerToken), outputTokens, price.value)
  const runId = yield* CurrentTurnRunId
  const hold = yield* ledger.reserve({
    ...Option.match(runId, { onNone: () => ({}), onSome: (value) => ({ runId: value }) }),
    amount,
    caps: {
      ...(options.turnCap === undefined ? {} : { turn: options.turnCap }),
      ...(options.totalCap === undefined ? {} : { total: options.totalCap }),
    },
  }).pipe(Effect.mapError((error) => refused("model.spend", error.message, error)))
  return Option.some({ ledger, hold, price: price.value })
})

/**
 * Close an ended attempt's hold (`spendSettlementOf`): settle it at what
 * its usage cost, or, with no usage reported, at what it held when its
 * request may have been billed (`reach`), else release it. A ledger that
 * cannot record it is logged, and the hold stays reserved.
 */
export const settleSend = (spend: Option.Option<AttemptSpend>, usage: ModelCallUsage, reach: SendReach): Effect.Effect<void> => Option.match(spend, {
  onNone: () => Effect.void,
  onSome: ({ ledger, hold, price }) => Option.match(spendSettlementOf(usage, reach, hold.amount, price), {
    onNone: () => ledger.release(hold),
    onSome: (cost) => ledger.settle(hold, cost),
  }).pipe(Effect.catch((error) => Effect.logWarning(`the model spend ledger did not record an attempt's end, so its hold stays reserved: ${reasonOf(Cause.fail(error))}`))),
})
