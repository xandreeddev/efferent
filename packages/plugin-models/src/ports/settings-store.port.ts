import { Context, Effect, Option, Schema } from "effect"
import { ReasoningEffort } from "@xandreed/core"

/**
 * The engine's settings — deliberately small. The model roles are the Aider
 * split: `model` is the general brain, `codeModel` backs code-writing work,
 * `fastModel` backs one-shot helper calls (titles, digests). Unset roles
 * follow `model`. Each value is a `"<provider>:<modelId>"` selection string.
 *
 * Beyond the roles: `fallbackModel` (the router's last rung once retries
 * exhaust) and the run knobs a driver may persist instead of re-flagging
 * every launch (`maxAttempts`, `budgetMillis`). Resolution stays the
 * driver's: flags > config > defaults. A key the schema does not name (one
 * an older release wrote) is not read.
 */
const optionField = <A, I>(schema: Schema.Codec<A, I>) =>
  Schema.OptionFromOptional(schema).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  )

/** @public */
export class EngineSettings extends Schema.Class<EngineSettings>("EngineSettings")({
  model: optionField(Schema.String),
  codeModel: optionField(Schema.String),
  fastModel: optionField(Schema.String),
  fallbackModel: optionField(Schema.String),
  maxAttempts: optionField(Schema.Number),
  budgetMillis: optionField(Schema.Number),
  /** Selected after the model because the accepted levels are model-specific. */
  reasoningEffort: optionField(ReasoningEffort),
  codeReasoningEffort: optionField(ReasoningEffort),
  fastReasoningEffort: optionField(ReasoningEffort),
}) {}

/** @public */
export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
  message: Schema.String,
  /**
   * `settings.corrupt`: the store's backing data could not be read or
   * decoded. Nothing was read as defaults and nothing was written over it.
   */
  code: Schema.optionalKey(Schema.Literal("settings.corrupt")),
}) {}

/**
 * The three model roles a selection can be persisted under.
 *
 * @public
 */
export type ModelRole = "general" | "code" | "fast"

/** The non-role keys the keyed setter may write — a closed vocabulary, so a
 *  typo can never land a dead key in the user's config.
 *
 * @public
 */
export const SETTINGS_KEYS = [
  "fallbackModel",
  "maxAttempts",
  "budgetMillis",
  "reasoningEffort",
  "codeReasoningEffort",
  "fastReasoningEffort",
] as const
/** @public */
export type SettingsKey = (typeof SETTINGS_KEYS)[number]

/**
 * Read-through settings port. `load` re-reads the backing store on every call
 * so a value changed mid-session takes effect on the next turn — callers must
 * not cache the result across turns. A store may be read-only: then
 * `setRole` and `set` fail with a `SettingsError` and write nothing. A store
 * whose backing data cannot be read or decoded fails `load` and every write
 * with a `SettingsError` of code `settings.corrupt` instead of reading it as
 * defaults, so no write replaces settings it could not read.
 * `settingsStoreConformance` (`@xandreed/plugin-models/conformance`) checks
 * a store against this contract. Its key stays `@xandreed/core/SettingsStore`,
 * the package it was first declared in: plugins' `provides` and hosts'
 * bindings name it, so it never changes.
 */
export class SettingsStore extends Context.Service<SettingsStore, {
    readonly load: Effect.Effect<EngineSettings, SettingsError>
    /** Persist one role's model selection (a role choice); `None` clears
     *  the role so it falls back to its default again. A selection that is
     *  not `"<provider>:<modelId>"` fails with a `SettingsError` and writes
     *  nothing. */
    readonly setRole: (
      role: ModelRole,
      selection: Option.Option<string>,
    ) => Effect.Effect<void, SettingsError>
    /** Persist one non-role key from its STRING form (a settings edit): the
     *  adapter validates + coerces per key ("true", "3", "provider:model")
     *  and rejects a value that doesn't parse with a `SettingsError`,
     *  writing nothing; `None` clears the key. */
    readonly set: (
      key: SettingsKey,
      value: Option.Option<string>,
    ) => Effect.Effect<void, SettingsError>
  }>()("@xandreed/core/SettingsStore") {}
