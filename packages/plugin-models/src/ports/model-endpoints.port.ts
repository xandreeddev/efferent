import { Context, Schema } from "effect"

/**
 * A configured model endpoint. Without api, or with chat-completions,
 * `<name>:<model id>` is sent to `<url>/chat/completions`. An explicit
 * anthropic-messages endpoint uses `<url>/v1/messages`; a final /v1 on the
 * base URL is accepted once. Its auth chooses x-api-key (default) or bearer,
 * apiVersion overrides the pinned SDK version, and betas merge with SDK flags.
 * Messages endpoints are gateways, not subscription sign-ins: they never add
 * the Claude Code system prelude. The key is
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
 * For chat completions, `images` defaults false: enabled images use
 * `image_url` parts, including a tool result's images in a user message
 * after the tool results. Messages endpoints default to the model profile
 * (true for unknown IDs), using Messages image blocks. Explicit false sends
 * label lines on either protocol. Chat usage reads cache tokens from
 * `prompt_tokens_details` and reasoning from `completion_tokens_details`;
 * Messages usage uses the provider SDK's native fields.
 *
 * @public
 */
const endpointFields = {
  url: Schema.String,
  apiKey: Schema.optionalKey(Schema.Union([
    Schema.String,
    Schema.Redacted(Schema.String).annotate({ message: "apiKey is a string or a Redacted string" }),
  ]).annotate({ message: "apiKey is a string or a Redacted string" })),
  apiKeyEnv: Schema.optionalKey(Schema.String),
  images: Schema.optionalKey(Schema.Boolean),
}

/** A base URL using chat completions, or an explicit Anthropic Messages protocol. @public */
export const ModelEndpoint = Schema.Union([
  Schema.Struct({
    ...endpointFields,
    /** Absent keeps the existing chat-completions protocol. */
    api: Schema.optionalKey(Schema.Literal("chat-completions")),
    standardOnly: Schema.optionalKey(Schema.Boolean),
  }).annotate({ messageUnexpectedKey: "not an option of a chat-completions endpoint" }),
  Schema.Struct({
    ...endpointFields,
    api: Schema.Literal("anthropic-messages"),
    /** The API key is opaque in either header; omission uses x-api-key. */
    auth: Schema.optionalKey(Schema.Literals(["x-api-key", "bearer"])),
    /** Preserve the pinned SDK's version by default; an explicit version is sent verbatim. */
    apiVersion: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
    /** Added to the SDK's own beta flags, in order with duplicates removed. */
    betas: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)))),
  }).annotate({ messageUnexpectedKey: "not an option of an anthropic-messages endpoint" }),
]).annotate({ messageUnexpectedKey: "not an option of a model endpoint" })
export type ModelEndpoint = typeof ModelEndpoint.Type

/**
 * Endpoints by provider name; a name that matches a built-in provider replaces it.
 *
 * @public
 */
export const ModelEndpoints = Schema.Record(Schema.String, ModelEndpoint)
export type ModelEndpoints = typeof ModelEndpoints.Type

/**
 * The endpoints the models plugin was configured with; none by default.
 *
 * @public
 */
export const CurrentModelEndpoints = Context.Reference<ModelEndpoints>("@xandreed/plugin-models/CurrentModelEndpoints", {
  defaultValue: () => ({}),
})
