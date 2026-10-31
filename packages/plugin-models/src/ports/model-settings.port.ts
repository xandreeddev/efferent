import { Context } from "effect"
import type { ModelSettingsMap } from "../llm/model-settings.entity.js"

/** Static per-model settings captured where the models layer is built. @public */
export const CurrentModelSettings = Context.Reference<ModelSettingsMap>("@xandreed/plugin-models/CurrentModelSettings", {
  defaultValue: () => ({}),
})
