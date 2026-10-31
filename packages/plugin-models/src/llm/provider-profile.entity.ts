import { Schema } from "effect"
import type { Option } from "effect"
import type { ModelLimits, ReasoningEffortType } from "@xandreed/core"
import { AnthropicEffort, ModelThinking } from "./model-settings.entity.js"

/** Documented native controls, or an explicitly labelled family policy for future IDs. */
export const AnthropicModelTraits = Schema.Struct({
  source: Schema.Literals(["documented", "family-policy"]),
  modes: Schema.Array(Schema.Literals(ModelThinking.discriminants)),
  defaultThinking: Schema.OptionFromNullOr(ModelThinking),
  defaultEffort: Schema.OptionFromNullOr(AnthropicEffort),
  forcedTools: Schema.OptionFromNullOr(Schema.Boolean),
  reducedEfforts: Schema.OptionFromNullOr(Schema.Array(AnthropicEffort)),
})
export type AnthropicModelTraits = typeof AnthropicModelTraits.Type

/** The providers the models plugin builds itself; any other is a configured endpoint. */
export const BuiltInProvider = Schema.Literals(["opencode", "openai-codex", "openai", "anthropic", "google"])
export type BuiltInProvider = typeof BuiltInProvider.Type

/** The OpenAI Responses API, at `apiUrl` (the SDK's own by default). */
export interface ResponsesRoute {
  readonly _tag: "openai-responses"
  readonly apiUrl: Option.Option<string>
  /** Sent as the model's `strictJsonSchema` option; none: the SDK's default. */
  readonly strictJsonSchema: Option.Option<boolean>
  /** Whose calls carry the call policy's effort: every model's, or only a model's that lists efforts (a non-reasoning model refuses one). */
  readonly effort: "always" | "listed"
}

/** An OpenAI-compatible gateway's chat completions. */
export interface ChatRoute {
  readonly _tag: "compat"
  /** The client's name in its failures. */
  readonly moduleName: string
  readonly chatUrl: string
  /** Standard chat-completions fields only (`CompatConfig.standardOnly`). */
  readonly standardOnly: boolean
  /** Whether the reasoning tokens are read (`UsageReading`). */
  readonly usage: { readonly reasoning: boolean }
}

/**
 * The wire a built-in model is sent over (its `_tag`), with what its client
 * needs beyond the model and the key: Anthropic's Messages API, the OpenAI
 * Responses API, the subscription's Codex dialect of it, or a gateway's chat
 * completions.
 */
export type Route = { readonly _tag: "anthropic" } | ResponsesRoute | { readonly _tag: "openai-codex" } | ChatRoute

/** A model of a built-in provider: whether its route sends it images (where not, they go as label lines), the efforts it takes, and whether its thinking is bound to the conversation. */
export interface ModelProfile {
  readonly id: string
  readonly images: boolean
  readonly efforts: ReadonlyArray<ReasoningEffortType>
  readonly limits?: ModelLimits
  readonly anthropic?: AnthropicModelTraits
  /**
   * The provider binds each thinking block's signature to the conversation
   * before it (system, tools, earlier messages): a block sent back after that
   * prefix changed is refused, unless the request says what to do with it
   * (the models plugin's `thinkingPrefixMismatch`).
   */
  readonly bindsThinking: boolean
}

/** One built-in provider: its catalog, what each model reads and takes, and the route each is sent over. */
export interface ProviderProfile {
  /** The catalog's name for the provider's route, before ` · <model>`; none: its entries have no label. */
  readonly label: Option.Option<string>
  /** The catalog: the models the provider lists, in order. */
  readonly models: ReadonlyArray<ModelProfile>
  /** A model's profile, listed or not: one the catalog does not list follows its family. */
  readonly modelOf: (modelId: string) => ModelProfile
  readonly routeOf: (modelId: string) => Route
}
