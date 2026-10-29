import { Context, Schema } from "effect"

/**
 * An OpenAI-compatible endpoint a host names in configuration: the model
 * `<name>:<model id>` is sent to `<url>/chat/completions`. The key is
 * optional — a local server or a private gateway may need none. It comes
 * from `apiKey`, then the environment variable `apiKeyEnv` names, then the
 * AuthStore's key for `<name>`; with none, no Authorization header is sent.
 * The variable is read with `Config`, from the current ConfigProvider (the
 * process environment unless the host provides another). An endpoint with
 * its own key (`apiKey`, or a set `apiKeyEnv`) never reads the AuthStore;
 * an empty one (`apiKey: ""`, or a variable set to "" under a provider that
 * keeps empty values, `ConfigProvider.fromEnv({ preserveEmptyStrings: true })`)
 * sends no key; the default environment provider reads "" as unset. A host's code passes `apiKey` as a `Redacted` string so it
 * prints as `<redacted>` in errors and graph fingerprints; JSON
 * configuration names an environment variable in `apiKeyEnv` instead.
 * `standardOnly` (default true) sends only standard chat-completions fields.
 * `images` (default false) says its models read images: a user's images are
 * then sent as `image_url` parts, and a tool result's in one user message
 * after the tool results; without it they are label lines.
 * The endpoint's usage is read in full: cache reads and writes from
 * `prompt_tokens_details`, reasoning from `completion_tokens_details`.
 */
export const ModelEndpoint = Schema.Struct({
  url: Schema.String,
  apiKey: Schema.optionalKey(Schema.Union([
    Schema.String,
    Schema.Redacted(Schema.String).annotate({ message: "apiKey is a string or a Redacted string" }),
  ]).annotate({ message: "apiKey is a string or a Redacted string" })),
  apiKeyEnv: Schema.optionalKey(Schema.String),
  standardOnly: Schema.optionalKey(Schema.Boolean),
  images: Schema.optionalKey(Schema.Boolean),
  // An unknown key is named, never its value: a misspelt `apiKey` holds a secret.
}).annotate({ messageUnexpectedKey: "not an option of a model endpoint" })
export type ModelEndpoint = typeof ModelEndpoint.Type

/** Endpoints by provider name; a name that matches a built-in provider replaces it. */
export const ModelEndpoints = Schema.Record(Schema.String, ModelEndpoint)
export type ModelEndpoints = typeof ModelEndpoints.Type

/** The endpoints the models plugin was configured with; none by default. */
export const CurrentModelEndpoints = Context.Reference<ModelEndpoints>("@xandreed/plugin-models/CurrentModelEndpoints", {
  defaultValue: () => ({}),
})
