import { Schema } from "effect"

/**
 * Core's own key beside the providers' namespaces: in a response part's
 * `metadata` (the finish part's {@link ResponseStamp}) and in a stored
 * message's `providerOptions` (the turn's usage and model). It is the only
 * key core writes there, and `toPromptMessages` leaves it out of every blob
 * it sends, so no provider receives it.
 *
 * @public
 */
export const ENGINE_KEY = "engine"

/**
 * What a response's finish part carries under {@link ENGINE_KEY}: the
 * resolved `provider:modelId` that produced it.
 *
 * @public
 */
export const ResponseStamp = Schema.Struct({ model: Schema.NonEmptyString })
export type ResponseStamp = typeof ResponseStamp.Type
