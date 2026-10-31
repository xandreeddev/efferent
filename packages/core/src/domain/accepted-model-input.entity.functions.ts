import { Option, Schema } from "effect"
import { Response } from "effect/ai"
import type { AcceptedModelInput } from "./accepted-model-input.entity.js"
import { responseModelOf } from "./engine-stamp.entity.functions.js"
import { parseModelSelection } from "./model-selection.entity.functions.js"

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const Input = Schema.Struct({
  total: Count.check(Schema.isGreaterThan(0)),
  cacheRead: Schema.optional(Count),
  cacheWrite: Schema.optional(Count),
}).check(Schema.makeFilter((input) => input.total >= (input.cacheRead ?? 0) + (input.cacheWrite ?? 0)
  ? true : "full input must include its cached shares"))
const decodeInput = Schema.decodeUnknownOption(Input)
const decodeUsage = Schema.decodeUnknownOption(Response.Usage)
const carriesUsage = (usage: Response.Usage): boolean => usage.inputTokens.total !== undefined || usage.outputTokens.total !== undefined

const selectedUsage = (usage: unknown, content: ReadonlyArray<Response.AnyPart>): Option.Option<Response.Usage> =>
  decodeUsage(usage).pipe(Option.orElse(() => Option.map(
    Option.fromNullishOr(content.findLast((part): part is Response.FinishPart => part.type === "finish" && carriesUsage(part.usage))),
    (part) => part.usage,
  )))

/**
 * Useful input measurement from the accepted response's selected SDK usage,
 * before normalized usage fills missing counters. The model is the response's
 * actual neutral stamp. Missing or zero input cannot calibrate an estimate.
 * Supplied SDK usage takes precedence; otherwise the last usage-carrying
 * finish is selected. Counts are never filled from a different snapshot.
 *
 * @public
 */
export const acceptedModelInputOf = (usage: unknown, content: ReadonlyArray<Response.AnyPart>): AcceptedModelInput => ({
  model: Option.flatMap(responseModelOf(content), parseModelSelection),
  inputTokens: selectedUsage(usage, content).pipe(Option.flatMap((value) => decodeInput(value.inputTokens)), Option.map((input) => input.total)),
})
