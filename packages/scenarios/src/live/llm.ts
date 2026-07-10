import { homedir } from "node:os"
import { LanguageModel } from "@effect/ai"
import { Effect, Layer, Option } from "effect"
import { AuthStore, SettingsStore, UtilityLlm } from "@xandreed/engine"
import {
  LanguageModelLive,
  LocalAuthStoreLive,
  LocalSettingsStoreLive,
  roleModelView,
  UtilityLlmLive,
} from "@xandreed/providers"

/**
 * The live batteries' model edges — the SAME service stacks production uses
 * (auth + settings resolved from the real `~/.efferent`), one builder per
 * tier. Packs self-provision at `boot`; nothing here is CI-reachable.
 */

const stores = (cwd: string) =>
  Layer.mergeAll(LocalAuthStoreLive(cwd, homedir()), LocalSettingsStoreLive(cwd, homedir()))

/** The FAST tier (`UtilityLlm`) — digests, memory curation, yes/no probes. */
export const utilityTier = (cwd: string): Layer.Layer<UtilityLlm> =>
  UtilityLlmLive.pipe(Layer.provide(stores(cwd)))

/** One strong-tier (code role) completion — the judge gate's call shape. */
export const codeTierCall = (cwd: string) => {
  const model = LanguageModelLive.pipe(
    Layer.provide(roleModelView("code")),
    Layer.provide(stores(cwd)),
  )
  return (prompt: string): Effect.Effect<string, unknown> =>
    LanguageModel.generateText({ prompt }).pipe(
      Effect.map((response) => response.text),
      Effect.provide(model),
    )
}

/** The GENERAL tier LanguageModel layer — the refiner's brain. */
export const generalTier = (cwd: string): Layer.Layer<LanguageModel.LanguageModel> =>
  LanguageModelLive.pipe(Layer.provide(stores(cwd)))

/** One GENERAL-tier completion — the JUDGE tier for graded work produced on
 *  other tiers (the critic must not ride the same model as the implementor
 *  it grades, nor the digest probes the model that wrote the digest). */
export const generalTierCall = (cwd: string) => {
  const model = generalTier(cwd)
  return (prompt: string): Effect.Effect<string, unknown> =>
    LanguageModel.generateText({ prompt }).pipe(
      Effect.map((response) => response.text),
      Effect.provide(model),
    )
}

/** The RESOLVED model ids per role, as provenance meta — merged into every
 *  live pack's `meta` so a model swap surfaces as version drift against the
 *  minted baseline exactly like a prompt bump (the models live in gitignored
 *  config; without this a swap shifts every baseline unattributably). */
export const modelMeta = (cwd: string): Effect.Effect<Record<string, string>> =>
  Effect.gen(function* () {
    const settings = yield* Effect.flatMap(SettingsStore, (store) => store.load)
    const role = (value: Option.Option<string>, fallback: Option.Option<string>): string =>
      Option.getOrElse(Option.orElse(value, () => fallback), () => "(unset)")
    return {
      "model.general": role(settings.model, Option.none()),
      "model.code": role(settings.codeModel, settings.model),
      "model.fast": role(settings.fastModel, settings.model),
    }
  }).pipe(
    Effect.provide(LocalSettingsStoreLive(cwd, homedir())),
    Effect.orElseSucceed(() => ({})),
  )

/** Pre-flight: at least one credential on disk, checked ONCE — a keyless run
 *  exits with one clear message, not twenty identical scenario errors. */
export const preflightAuth = (cwd: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const auth = yield* AuthStore
    const all = yield* auth.all
    return all.size > 0
  }).pipe(
    Effect.provide(LocalAuthStoreLive(cwd, homedir())),
    Effect.option,
    Effect.map(Option.match({ onNone: () => false, onSome: (has) => has })),
  )
