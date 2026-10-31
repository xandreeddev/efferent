import { Effect, Layer, Option } from "effect"
import { ModelCatalog } from "@xandreed/core"
import { AuthStore } from "../ports/auth-store.port.js"
import type { ModelCatalogEntryType, ModelLimits, ReasoningEffortType } from "@xandreed/core"
import type { Credential } from "../ports/auth-store.port.js"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import type { ModelEndpoint, ModelEndpoints } from "../ports/model-endpoints.port.js"
import { CurrentModelSettings } from "../ports/model-settings.port.js"
import type { ModelSettingsMap } from "./model-settings.entity.js"
import type { ModelProfile } from "./provider-profile.entity.js"
import { anthropicProfileOf, modelProfileOf, profileOf, PROVIDER_PROFILES } from "./provider-profile.entity.functions.js"

/** OpenCode serves its GPT models through the OpenAI Responses protocol, the others through chat completions. */
export const usesOpenCodeResponses = (modelId: string): boolean =>
  PROVIDER_PROFILES.opencode.routeOf(modelId)._tag === "openai-responses"

/**
 * Whether a built-in route sends a model images: Anthropic's Messages API,
 * the OpenAI Responses routes (`openai`, `openai-codex` but its text-only
 * Spark model, OpenCode's `gpt-*`) and Gemini's chat completions do;
 * OpenCode's other models are text-only until each is verified. A
 * configured endpoint says so itself (`ModelEndpoint.images`). Where it is
 * false, a request's images are sent as label lines.
 *
 * @public
 */
export const imageInputFor = (selection: string): boolean =>
  Option.exists(modelProfileOf(selection), (model) => model.images)

/**
 * Whether the route `buildProvider` sends a catalog model through reads
 * images: a configured endpoint of the provider's name by its `images`
 * (Messages defaults to its model profile, chat to false), a `local` credential's URL never, a built-in route by
 * the model's profile.
 */
const routeReadsImages = (provider: string, model: ModelProfile, credential: Credential, endpoints: ModelEndpoints): boolean =>
  Option.match(Object.hasOwn(endpoints, provider) ? Option.fromNullishOr(endpoints[provider]) : Option.none<ModelEndpoint>(), {
    onSome: (endpoint) => endpoint.images ?? (endpoint.api === "anthropic-messages" ? anthropicProfileOf(model.id).images : false),
    onNone: () => !(credential.type === "local" && credential.baseUrl !== undefined) && model.images,
  })

const routeLimits = (provider: string, model: ModelProfile, credential: Credential, endpoints: ModelEndpoints, settings: ModelSettingsMap): Option.Option<ModelLimits> => {
  const messages = Option.match(Object.hasOwn(endpoints, provider) ? Option.fromNullishOr(endpoints[provider]) : Option.none<ModelEndpoint>(), {
    onSome: (endpoint) => endpoint.api === "anthropic-messages",
    onNone: () => !(credential.type === "local" && credential.baseUrl !== undefined) && Option.exists(profileOf(provider), (profile) => profile.routeOf(model.id)._tag === "anthropic"),
  })
  if (!messages) return Option.none()
  const selection = `${provider}:${model.id}`
  const configured = Object.hasOwn(settings, selection) ? settings[selection]?.limits : undefined
  const limits = { ...anthropicProfileOf(model.id).limits, ...configured }
  return Object.keys(limits).length === 0 ? Option.none() : Option.some(limits)
}

/**
 * The models of every provider with a credential. Each entry's `input` is
 * what its route reads, as `buildProvider` routes it: `endpoints` (the
 * models plugin's configured ones; none by default) replace a built-in
 * route of their name.
 */
export const configuredModelCatalog = (
  credentials: ReadonlyMap<string, Credential>,
  endpoints: ModelEndpoints = {},
  settings: ModelSettingsMap = {},
): ReadonlyArray<ModelCatalogEntryType> =>
  [...credentials].flatMap(([provider, credential]) =>
    Option.match(profileOf(provider), {
      onNone: () => [],
      onSome: (profile) => profile.models.map((model): ModelCatalogEntryType => ({
        selection: `${provider}:${model.id}`,
        ...Option.match(profile.label, { onNone: () => ({}), onSome: (label) => ({ label: `${label} · ${model.id}` }) }),
        provider,
        credential: credential.type,
        input: routeReadsImages(provider, model, credential, endpoints) ? ["text", "image"] : ["text"],
        ...Option.match(routeLimits(provider, model, credential, endpoints, settings), { onNone: () => ({}), onSome: (limits) => ({ limits }) }),
      })),
    }),
  )

/** @public */
export type ReasoningEffort = ReasoningEffortType

/**
 * A built-in model profile's reasoning controls. Configured route overrides are not inferred here.
 *
 * @public
 */
export const reasoningEffortsFor = (selection: string): ReadonlyArray<ReasoningEffort> =>
  Option.match(modelProfileOf(selection), { onNone: () => [], onSome: (model) => model.efforts })

/** The efforts of the public OpenAI API's vocabulary, which the OpenAI Responses routes and the chat-completions gateways take. */
export type PublicReasoningEffort = "low" | "medium" | "high"

/**
 * An effort in the public vocabulary: `xhigh` and `max` are `high`, `none`
 * is `low`, the others themselves. Only the subscription dialect takes the
 * whole vocabulary (and only it is probe-verified for `none`). Anthropic
 * Messages uses its own native effort resolution instead of this clamp.
 */
export const publicReasoningEffort = (effort: ReasoningEffort): PublicReasoningEffort =>
  effort === "xhigh" || effort === "max" ? "high" : effort === "none" ? "low" : effort

/**
 * The catalog over the AuthStore's credentials and the configured endpoints (`CurrentModelEndpoints`).
 *
 * @public
 */
export const ConfiguredModelCatalogLive = Layer.effect(
  ModelCatalog,
  Effect.all({ auth: AuthStore, endpoints: Effect.service(CurrentModelEndpoints), settings: Effect.service(CurrentModelSettings) }, { concurrency: 1 }).pipe(Effect.map(({ auth, endpoints, settings }) => ({
    list: auth.all.pipe(
      Effect.tapError((error) => Effect.logWarning("the model catalog could not read the stored credentials; it lists none of them", error)),
      Effect.orElseSucceed(() => new Map<string, Credential>()),
      Effect.map((credentials) => configuredModelCatalog(credentials, endpoints, settings)),
    ),
  }))),
)
