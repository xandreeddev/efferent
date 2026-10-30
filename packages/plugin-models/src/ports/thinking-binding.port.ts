import { Context } from "effect"
import type { ThinkingPrefixMismatch } from "../llm/thinking-binding.entity.js"

/**
 * What the models plugin was configured to tell a model that binds thinking
 * to the conversation (`thinkingPrefixMismatch`): `provider-default` (send
 * nothing) unless the plugin sets it.
 */
export const CurrentThinkingPrefixMismatch = Context.Reference<ThinkingPrefixMismatch>("@xandreed/plugin-models/CurrentThinkingPrefixMismatch", {
  defaultValue: () => "provider-default",
})
