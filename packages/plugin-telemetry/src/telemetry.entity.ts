import { Schema } from "effect"
import { ModelPrice } from "@xandreed/core"

/**
 * What the telemetry plugin records for each turn it sees.
 * - `prices`: a model's prices (per million tokens, in the host's currency,
 *   usually USD), keyed by each recorded call's actual
 *   `"<provider>:<modelId>"` selection (legacy selected responses when a
 *   turn has no call ledger). A response from an unpriced model, or with no model (a
 *   `LanguageModel` the models plugin did not route), has no cost.
 * - `metricAttributes`: constant attributes added to every metric the
 *   plugin records, such as `deployment.environment`. Keep them few and
 *   bounded: each distinct value is a new series. Never put a session, run
 *   or user id here (those are on the spans).
 * - `spanEvents`: whether the plugin also writes to the span current where
 *   it is built (the turn's `agent.turn` under `Agent.turn`): the turn's ids
 *   as attributes, an event per response, refusal and stream fallback, and
 *   the running cost.
 *
 * Flat. The options of the plugin this package shipped before 0.11.0
 * (`enabled`, `serviceName`) are refused; export is the host's
 * `OtlpTelemetryLive` now.
 *
 * @public
 */
export const TelemetryOptions = Schema.Struct({
  prices: Schema.Record(Schema.String, ModelPrice),
  metricAttributes: Schema.Record(Schema.String, Schema.String),
  spanEvents: Schema.Boolean,
})
export type TelemetryOptions = typeof TelemetryOptions.Type

/** @public */
export const telemetryDefaults: TelemetryOptions = { prices: {}, metricAttributes: {}, spanEvents: true }

/**
 * The five kinds a response's tokens are billed by, as `efferent.token.kind`
 * names them (core's `usageBreakdown`): uncached input, cache reads, cache
 * writes, reasoning, and output without its reasoning. For one response
 * they sum to its `totalTokens`.
 */
export const TokenKind = Schema.Literals(["input", "cache_read", "cache_write", "reasoning", "output"])
export type TokenKind = typeof TokenKind.Type

/** A response's tokens of one kind (`count > 0` only: a kind the response did not bill is left out). */
export const TokenCount = Schema.Struct({
  kind: TokenKind,
  count: Schema.Number,
})
export type TokenCount = typeof TokenCount.Type

/** The model attribute of a response with no model (a host's own `LanguageModel`, a planned step). */
export const UNKNOWN_MODEL = "unknown"
