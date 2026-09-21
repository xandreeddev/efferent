import { homedir } from "node:os"
import { LanguageModel } from "@effect/ai"
import { Effect, Layer, Option, Schema } from "effect"
import { AuthStore, definePlugin, EngineSettings, ModelCatalog, SessionEnvironment, SettingsError, SettingsStore, UtilityLlm } from "@xandreed/core"
import { LocalAuthStoreLive } from "./auth/localAuth.js"
import { LanguageModelLive } from "./llm/router.js"
import { UtilityLlmLive } from "./llm/utilityLlm.js"
import { ConfiguredModelCatalogLive } from "./llm/modelCatalog.js"
import { LocalSettingsStoreLive } from "./settings/localSettings.js"

const Config = Schema.Struct({ model: Schema.String, fastModel: Schema.String, fallbackModel: Schema.String, inheritPrevious: Schema.Boolean })
export const modelsPlugin = definePlugin({
  id: "@xandreed/plugin-models", version: "0.2.0-next.0", config: Config,
  defaults: { model: "", fastModel: "", fallbackModel: "", inheritPrevious: true }, requires: [SessionEnvironment],
  provides: [LanguageModel.LanguageModel, UtilityLlm, AuthStore, SettingsStore, ModelCatalog],
  layer: (config) => Layer.unwrapEffect(Effect.gen(function* () {
    const { workspace } = yield* SessionEnvironment
    const previous = config.inheritPrevious
      ? yield* SettingsStore.pipe(Effect.flatMap((settings) => settings.load), Effect.provide(LocalSettingsStoreLive(workspace, homedir())))
      : new EngineSettings({})
    const optional = (value: string) => value.length === 0 ? Option.none<string>() : Option.some(value)
    const settings = Layer.succeed(SettingsStore, {
      load: Effect.succeed(new EngineSettings({ ...previous, model: Option.orElse(optional(config.model), () => previous.model), fastModel: Option.orElse(optional(config.fastModel), () => previous.fastModel), fallbackModel: Option.orElse(optional(config.fallbackModel), () => previous.fallbackModel) })),
      setRole: () => Effect.fail(new SettingsError({ message: "Edit the models plugin configuration to change a model" })),
      set: () => Effect.fail(new SettingsError({ message: "Edit the models plugin configuration to change settings" })),
    })
    const base = Layer.merge(settings, LocalAuthStoreLive(workspace, homedir(), ".efferent/runtime", config.inheritPrevious ? ".efferent" : undefined))
    return Layer.mergeAll(LanguageModelLive, UtilityLlmLive, ConfiguredModelCatalogLive).pipe(Layer.provideMerge(base))
  })),
})
export default modelsPlugin
