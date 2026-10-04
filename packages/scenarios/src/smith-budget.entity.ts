import { Schema } from "effect"

export const ModelPrice = Schema.Struct({ selector: Schema.String, inputUsdPerMillion: Schema.Number, outputUsdPerMillion: Schema.Number, sourceUrl: Schema.String, checkedAt: Schema.String })
export type ModelPrice = typeof ModelPrice.Type
export const SmithBudgetLimits = Schema.Struct({ spendCapUsd: Schema.Number, maxRequests: Schema.Int, maxInputBytesPerRequest: Schema.Int, maxOutputTokensPerRequest: Schema.Int, unpricedSelectors: Schema.Array(Schema.String), maxUnpricedRequests: Schema.Int })
export type SmithBudgetLimits = typeof SmithBudgetLimits.Type
export const RequestReservation = Schema.Struct({ selector: Schema.String, inputBytes: Schema.Int, outputTokens: Schema.NullOr(Schema.Int), reservedUsd: Schema.NullOr(Schema.Number), sourceUrl: Schema.NullOr(Schema.String) })
export type RequestReservation = typeof RequestReservation.Type
export class SmithBudgetExceeded extends Schema.TaggedError<SmithBudgetExceeded>()("SmithBudgetExceeded", { message: Schema.String }) {}
// The provider adapter routes through Go; reserve its peak rate even off-peak.
export const FLASH_PRICE: ModelPrice = { selector: "opencode:deepseek-v4-flash", inputUsdPerMillion: 0.30, outputUsdPerMillion: 1.20, sourceUrl: "https://opencode.ai/docs/go/", checkedAt: "2026-10-03" }

export const JEV_PRICE: ModelPrice = { selector: "opencode:jev-1.13", inputUsdPerMillion: 0.042, outputUsdPerMillion: 0, sourceUrl: "https://opencode.ai/docs/en/zen/", checkedAt: "2026-10-03" }
// Reserve the provider-table ceiling, without promotional or cache discounts.
export const VERCEL_FLASH_PRICE: ModelPrice = { selector: "vercel:deepseek/deepseek-v4.1-flash", inputUsdPerMillion: 0.30, outputUsdPerMillion: 1.20, sourceUrl: "https://vercel.com/ai-gateway/models/deepseek-v4.1-flash", checkedAt: "2026-10-03" }
// The catalog gives the exact rate; the model page rounds $0.042/M to $0.04/M.
export const VERCEL_JEV_PRICE: ModelPrice = { selector: "vercel:typesafe-ai/jev", inputUsdPerMillion: 0.042, outputUsdPerMillion: 0, sourceUrl: "https://ai-gateway.vercel.sh/v1/models", checkedAt: "2026-10-03" }
