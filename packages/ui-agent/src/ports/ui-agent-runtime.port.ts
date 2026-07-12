import { LanguageModel } from "@effect/ai"
import { Context } from "effect"
import type { UiAgentProfile } from "../domain/ui-agent-profile.entity.js"

export interface UiAgentModelsService {
  readonly planner: LanguageModel.Service
  readonly composer: LanguageModel.Service
  readonly repair: LanguageModel.Service
}

export class UiAgentModels extends Context.Tag("@xandreed/ui-agent/UiAgentModels")<UiAgentModels, UiAgentModelsService>() {}
export class UiAgentExecutionProfile extends Context.Tag("@xandreed/ui-agent/UiAgentExecutionProfile")<UiAgentExecutionProfile, UiAgentProfile>() {}
