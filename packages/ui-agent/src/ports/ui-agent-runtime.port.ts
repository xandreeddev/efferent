import { LanguageModel } from "effect/ai"
import { Context } from "effect"
import type { UiAgentProfile } from "../domain/ui-agent-profile.entity.js"

export interface UiAgentModelsService {
  readonly planner: LanguageModel.LanguageModel
  readonly composer: LanguageModel.LanguageModel
  readonly repair: LanguageModel.LanguageModel
}

export class UiAgentModels extends Context.Service<UiAgentModels, UiAgentModelsService>()("@xandreed/ui-agent/UiAgentModels") {}
export class UiAgentExecutionProfile extends Context.Service<UiAgentExecutionProfile, UiAgentProfile>()("@xandreed/ui-agent/UiAgentExecutionProfile") {}
