import { Context } from "effect"
import type { PromptCacheFrame } from "../llm/prompt-cache-frame.entity.js"

/** A captured SDK client reads this immutable frame in the invoking call's fiber. */
export const CurrentPromptCacheFrame = Context.Reference<PromptCacheFrame>("@xandreed/plugin-models/CurrentPromptCacheFrame", {
  defaultValue: () => ({ candidates: [], policy: { _tag: "Off" }, capability: true }),
})
