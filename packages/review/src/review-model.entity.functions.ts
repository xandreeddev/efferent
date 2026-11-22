import type { Effort, ReviewModel } from "./review-model.entity.js"

/**
 * The model asked at an effort: unchanged for `default`; on the chat wire, its body fields (`extra`) with the gateway's
 * `reasoning` field set, `{ enabled: false }` for `none`, `{ effort }` for the others; on the Messages wire, its
 * `effort`, which `reviewModel` sends as adaptive thinking.
 */
export const withEffort = (model: ReviewModel, effort: Effort): ReviewModel => {
  if (effort === "default") return model
  if (model.wire === "messages") return { ...model, effort }
  return { ...model, extra: { ...model.extra, reasoning: effort === "none" ? { enabled: false } : { effort } } }
}
