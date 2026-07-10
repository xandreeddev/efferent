import { Context, Option, Schema } from "effect"
import type { Effect } from "effect"

/**
 * The engine's settings — deliberately small. The model roles are the Aider
 * split: `model` is the general brain, `codeModel` backs code-writing work,
 * `fastModel` backs one-shot helper calls (titles, digests). Unset roles
 * follow `model`. Each value is a `"<provider>:<modelId>"` selection string.
 *
 * Beyond the roles: `fallbackModel` (the router's last rung once retries
 * exhaust) and the run knobs a driver may persist instead of re-flagging
 * every launch (`sandbox`, `maxAttempts`, `budgetMillis`). Resolution stays
 * the driver's: flags > config > defaults.
 */
const optionField = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.optionalWith(schema, { as: "Option" }).pipe(
    Schema.withConstructorDefault(Option.none),
  )

export class EngineSettings extends Schema.Class<EngineSettings>("EngineSettings")({
  model: optionField(Schema.String),
  codeModel: optionField(Schema.String),
  fastModel: optionField(Schema.String),
  fallbackModel: optionField(Schema.String),
  sandbox: optionField(Schema.Boolean),
  maxAttempts: optionField(Schema.Number),
  budgetMillis: optionField(Schema.Number),
}) {}

export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
  message: Schema.String,
}) {}

/** The three model roles a selection can be persisted under. */
export type ModelRole = "general" | "code" | "fast"

/** The non-role keys the keyed setter may write — a closed vocabulary, so a
 *  typo can never land a dead key in the user's config. */
export const SETTINGS_KEYS = ["fallbackModel", "sandbox", "maxAttempts", "budgetMillis"] as const
export type SettingsKey = (typeof SETTINGS_KEYS)[number]

/**
 * Read-through settings port. `load` re-reads the backing store on every call
 * so a value changed mid-session takes effect on the next turn — callers must
 * not cache the result across turns.
 */
export class SettingsStore extends Context.Tag("@xandreed/engine/SettingsStore")<
  SettingsStore,
  {
    readonly load: Effect.Effect<EngineSettings, SettingsError>
    /** Persist one role's model selection (the human's `:model` action);
     *  `None` clears the role so it falls back to its default again. */
    readonly setRole: (
      role: ModelRole,
      selection: Option.Option<string>,
    ) => Effect.Effect<void, SettingsError>
    /** Persist one non-role key from its STRING form (the `:settings`
     *  action): the adapter validates + coerces per key ("true", "3",
     *  "provider:model") and rejects a value that doesn't parse; `None`
     *  clears the key. */
    readonly set: (
      key: SettingsKey,
      value: Option.Option<string>,
    ) => Effect.Effect<void, SettingsError>
  }
>() {}
