import { Context, Schema } from "effect"
import type { Effect } from "effect"

/**
 * The engine's settings — deliberately small. The model roles are the Aider
 * split: `model` is the general brain, `codeModel` backs code-writing work,
 * `fastModel` backs one-shot helper calls (titles, digests). Unset roles
 * follow `model`. Each value is a `"<provider>:<modelId>"` selection string.
 */
export class EngineSettings extends Schema.Class<EngineSettings>("EngineSettings")({
  model: Schema.optionalWith(Schema.String, { as: "Option" }),
  codeModel: Schema.optionalWith(Schema.String, { as: "Option" }),
  fastModel: Schema.optionalWith(Schema.String, { as: "Option" }),
}) {}

export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
  message: Schema.String,
}) {}

/**
 * Read-through settings port. `load` re-reads the backing store on every call
 * so a value changed mid-session takes effect on the next turn — callers must
 * not cache the result across turns.
 */
export class SettingsStore extends Context.Tag("@xandreed/engine/SettingsStore")<
  SettingsStore,
  {
    readonly load: Effect.Effect<EngineSettings, SettingsError>
    /** Persist the general model selection (the human's `/model` action). */
    readonly setModel: (selection: string) => Effect.Effect<void, SettingsError>
  }
>() {}
