import { Option } from "effect"
import { parseModelSelection } from "@xandreed/engine"
import { UI_AGENT_RECIPE_SET_VERSION, UI_AGENT_SCHEMA_VERSION } from "./ui-agent-profile.entity.js"
import type { UiAgentProfile } from "./ui-agent-profile.entity.js"

export const validateUiAgentProfile = (
  profile: UiAgentProfile,
  expectedPrompts: { readonly planner: string; readonly composer: string; readonly repair: string },
): ReadonlyArray<string> => [
  ...(profile.profile === "streaming-ui-v1" ? [] : ["profile id must be streaming-ui-v1"]),
  ...(profile.version.length > 0 ? [] : ["profile version is required"]),
  ...(profile.schemaVersion === UI_AGENT_SCHEMA_VERSION ? [] : [`schemaVersion must be ${UI_AGENT_SCHEMA_VERSION}`]),
  ...(profile.recipeSetVersion === UI_AGENT_RECIPE_SET_VERSION ? [] : [`recipeSetVersion must be ${UI_AGENT_RECIPE_SET_VERSION}`]),
  ...(profile.prompts.planner === expectedPrompts.planner ? [] : [`planner prompt must be ${expectedPrompts.planner}`]),
  ...(profile.prompts.composer === expectedPrompts.composer ? [] : [`composer prompt must be ${expectedPrompts.composer}`]),
  ...(profile.prompts.repair === expectedPrompts.repair ? [] : [`repair prompt must be ${expectedPrompts.repair}`]),
  ...[profile.planner, profile.composer, profile.repair].flatMap((stage) => [
    ...(Option.isSome(parseModelSelection(stage.model)) ? [] : [`invalid pinned model ${stage.model}`]),
    ...(stage.timeoutMs >= 250 && stage.timeoutMs <= 60_000 ? [] : [`timeout for ${stage.model} must be between 250ms and 60000ms`]),
    ...(stage.maxOutputTokens >= 128 && stage.maxOutputTokens <= 16_384 ? [] : [`output budget for ${stage.model} is outside 128..16384`]),
    ...(stage.maxSteps >= 1 && stage.maxSteps <= 16 ? [] : [`maxSteps for ${stage.model} is outside 1..16`]),
  ]),
  ...(profile.fallback.policy === "profile" && Option.isNone(parseModelSelection(profile.fallback.model)) ? [`invalid fallback model ${profile.fallback.model}`] : []),
  ...(profile.repair.maxAttempts === 1 ? [] : ["repair must be exactly one bounded attempt"]),
  ...((profile.composer.workers ?? 1) >= 1 && (profile.composer.workers ?? 1) <= 4 ? [] : ["composer workers must be within 1..4"]),
]
