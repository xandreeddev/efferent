import { Schema } from "effect"
import { UiGenerationProtocol } from "./ui-generation-protocol.entity.js"

export const UI_AGENT_SCHEMA_VERSION = "2.0.0"
export const UI_AGENT_RECIPE_SET_VERSION = "2.0.0"

export const UiModelStage = Schema.Struct({
  model: Schema.String,
  effort: Schema.Literal("low", "medium", "high"),
  timeoutMs: Schema.Number,
  maxOutputTokens: Schema.Number,
  maxSteps: Schema.Number,
})
export type UiModelStage = typeof UiModelStage.Type

export const UiAgentProfile = Schema.Struct({
  profile: Schema.String,
  version: Schema.String,
  schemaVersion: Schema.String,
  recipeSetVersion: Schema.String,
  protocol: Schema.optional(UiGenerationProtocol),
  prompts: Schema.Struct({ planner: Schema.String, composer: Schema.String, repair: Schema.String }),
  planner: UiModelStage,
  composer: UiModelStage,
  repair: Schema.Struct({
    model: Schema.String,
    effort: Schema.Literal("low", "medium", "high"),
    timeoutMs: Schema.Number,
    maxOutputTokens: Schema.Number,
    maxSteps: Schema.Number,
    maxAttempts: Schema.Number,
  }),
  fallback: Schema.Union(
    Schema.Struct({ policy: Schema.Literal("none") }),
    Schema.Struct({ policy: Schema.Literal("profile"), model: Schema.String }),
  ),
})
export type UiAgentProfile = typeof UiAgentProfile.Type
