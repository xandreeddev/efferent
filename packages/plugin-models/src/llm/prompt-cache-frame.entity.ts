import { Schema } from "effect"
import { PromptCacheControl, PromptCacheSettings } from "./prompt-cache.entity.js"

/** Per-call references identify provisional controls after SDK conversion. Never encoded. */
export const PromptCacheFrame = Schema.Struct({
  candidates: Schema.Array(Schema.Struct({
    control: PromptCacheControl,
    priority: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  })),
  policy: PromptCacheSettings,
  capability: Schema.Boolean,
})
export type PromptCacheFrame = typeof PromptCacheFrame.Type
