import { Context } from "effect"
import type { ThinkingPrefixMismatch } from "../llm/thinking-binding.entity.js"

/**
 * What the models plugin was configured to tell a model that binds thinking
 * to the conversation (`thinkingPrefixMismatch`): `drop_block` for adaptive thinking by default;
 * `provider-default` opts out of the explicit binding field.
 */
export const CurrentThinkingPrefixMismatch = Context.Reference<ThinkingPrefixMismatch>("@xandreed/plugin-models/CurrentThinkingPrefixMismatch", {
  defaultValue: () => "drop_block",
})
