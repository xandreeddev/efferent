import type { Effort, ReviewModel } from "./review-model.entity.js"

/**
 * The model asked at an effort: unchanged for `default`; otherwise its body fields (`extra`) with the gateway's
 * `reasoning` field set, `{ enabled: false }` for `none`, `{ effort }` for the others.
 */
export const withEffort = (model: ReviewModel, effort: Effort): ReviewModel =>
  effort === "default" ? model : { ...model, extra: { ...model.extra, reasoning: effort === "none" ? { enabled: false } : { effort } } }
