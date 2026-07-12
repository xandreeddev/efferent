import { LanguageModel } from "@effect/ai"
import { Effect, Layer, Option, Schema } from "effect"
import { parseModelSelection } from "@xandreed/engine"
import { LanguageModelSelectionLive } from "@xandreed/providers"
import { UI_COMPOSER_PROMPT_VERSION, UI_PLANNER_PROMPT_VERSION, UI_REPAIR_PROMPT_VERSION, UiAgentExecutionProfile, UiAgentModels, UiAgentProfile, validateUiAgentProfile } from "@xandreed/ui-agent"
import type { UiAgentProfileType } from "@xandreed/ui-agent"
import profileJson from "@xandreed/ui-agent/profiles/streaming-ui-v1"

const expectedPrompts = {
  planner: UI_PLANNER_PROMPT_VERSION,
  composer: UI_COMPOSER_PROMPT_VERSION,
  repair: UI_REPAIR_PROMPT_VERSION,
}

export const UiAgentExecutionProfileLive = Layer.effect(
  UiAgentExecutionProfile,
  Schema.decodeUnknown(UiAgentProfile)(profileJson).pipe(
    Effect.mapError((issue) => new Error(`invalid UI-agent profile: ${String(issue)}`)),
    Effect.flatMap((profile) => {
      const findings = validateUiAgentProfile(profile, expectedPrompts)
      return findings.length === 0
        ? Effect.succeed(profile)
        : Effect.fail(new Error(`UI-agent profile refused startup:\n${findings.map((finding) => `- ${finding}`).join("\n")}`))
    }),
  ),
)

const selection = (raw: string) => Option.getOrThrow(parseModelSelection(raw))

const service = (raw: string, profile: UiAgentProfileType) =>
  LanguageModel.LanguageModel.pipe(
    Effect.provide(LanguageModelSelectionLive(
      selection(raw),
      profile.fallback.policy === "profile" ? Option.some(selection(profile.fallback.model)) : Option.none(),
    )),
  )

const UiAgentModelsLive = Layer.effect(
  UiAgentModels,
  Effect.gen(function* () {
    const profile = yield* UiAgentExecutionProfile
    const [planner, composer, repair] = yield* Effect.all([
      service(profile.planner.model, profile),
      service(profile.composer.model, profile),
      service(profile.repair.model, profile),
    ])
    return { planner, composer, repair }
  }),
)

export const UiAgentRuntimeLive = UiAgentModelsLive.pipe(
  Layer.provideMerge(UiAgentExecutionProfileLive),
)
