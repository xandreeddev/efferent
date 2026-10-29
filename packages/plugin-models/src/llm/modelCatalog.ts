import { Effect, Layer, Option } from "effect"
import { AuthStore, ModelCatalog } from "@xandreed/core"
import type { Credential, ModelCatalogEntryType, ReasoningEffortType } from "@xandreed/core"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import type { ModelEndpoints } from "../ports/model-endpoints.port.js"
import type { ModelProfile } from "./provider-profile.entity.js"
import { modelProfileOf, profileOf, PROVIDER_PROFILES } from "./provider-profile.entity.functions.js"

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
 */
export const imageInputFor = (selection: string): boolean =>
  Option.exists(modelProfileOf(selection), (model) => model.images)

/**
 * Whether the route `buildProvider` sends a catalog model through reads
 * images: a configured endpoint of the provider's name by its `images`
 * (default false), a `local` credential's URL never, a built-in route by
 * the model's profile.
 */
const routeReadsImages = (provider: string, model: ModelProfile, credential: Credential, endpoints: ModelEndpoints): boolean =>
  Option.match(Option.fromNullishOr(endpoints[provider]), {
    onSome: (endpoint) => endpoint.images ?? false,
    onNone: () => !(credential.type === "local" && credential.baseUrl !== undefined) && model.images,
  })

/**
 * The models of every provider with a credential. Each entry's `input` is
 * what its route reads, as `buildProvider` routes it: `endpoints` (the
 * models plugin's configured ones; none by default) replace a built-in
 * route of their name.
 */
export const configuredModelCatalog = (
  credentials: ReadonlyMap<string, Credential>,
  endpoints: ModelEndpoints = {},
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
      })),
    }),
  )

export type ReasoningEffort = ReasoningEffortType

/** The reasoning controls accepted by each routed model (its profile's efforts; none for a provider not built in). */
export const reasoningEffortsFor = (selection: string): ReadonlyArray<ReasoningEffort> =>
  Option.match(modelProfileOf(selection), { onNone: () => [], onSome: (model) => model.efforts })

/** The efforts of the public OpenAI API's vocabulary, which the OpenAI Responses routes and the chat-completions gateways take. */
export type PublicReasoningEffort = "low" | "medium" | "high"

/**
 * An effort in the public vocabulary: `xhigh` and `max` are `high`, `none`
 * is `low`, the others themselves. Only the subscription dialect takes the
 * whole vocabulary (and only it is probe-verified for `none`); every other
 * route clamps.
 */
export const publicReasoningEffort = (effort: ReasoningEffort): PublicReasoningEffort =>
  effort === "xhigh" || effort === "max" ? "high" : effort === "none" ? "low" : effort

/** The catalog over the AuthStore's credentials and the configured endpoints (`CurrentModelEndpoints`). */
export const ConfiguredModelCatalogLive = Layer.effect(
  ModelCatalog,
  Effect.all({ auth: AuthStore, endpoints: Effect.service(CurrentModelEndpoints) }, { concurrency: 1 }).pipe(Effect.map(({ auth, endpoints }) => ({
    list: auth.all.pipe(
      Effect.tapError((error) => Effect.logWarning("the model catalog could not read the stored credentials; it lists none of them", error)),
      Effect.orElseSucceed(() => new Map<string, Credential>()),
      Effect.map((credentials) => configuredModelCatalog(credentials, endpoints)),
    ),
  }))),
)
