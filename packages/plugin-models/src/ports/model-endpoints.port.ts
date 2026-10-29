import { Context, Schema } from "effect"

/**
 * An OpenAI-compatible endpoint a host names in configuration: the model
 * `<name>:<model id>` is sent to `<url>/chat/completions`. The key is
 * optional — a local server or a private gateway may need none. It comes
 * from `apiKey`, then the environment variable `apiKeyEnv` names, then the
 * AuthStore's key for `<name>`; with none, no Authorization header is sent.
 * `standardOnly` (default true) sends only standard chat-completions fields.
 * The endpoint's usage is read in full: cache reads and writes from
 * `prompt_tokens_details`, reasoning from `completion_tokens_details`.
 */
export const ModelEndpoint = Schema.Struct({
  url: Schema.String,
  apiKey: Schema.optionalKey(Schema.String),
  apiKeyEnv: Schema.optionalKey(Schema.String),
  standardOnly: Schema.optionalKey(Schema.Boolean),
})
export type ModelEndpoint = typeof ModelEndpoint.Type

/** Endpoints by provider name; a name that matches a built-in provider replaces it. */
export const ModelEndpoints = Schema.Record(Schema.String, ModelEndpoint)
export type ModelEndpoints = typeof ModelEndpoints.Type

/** The endpoints the models plugin was configured with; none by default. */
export const CurrentModelEndpoints = Context.Reference<ModelEndpoints>("@xandreed/plugin-models/CurrentModelEndpoints", {
  defaultValue: () => ({}),
})
