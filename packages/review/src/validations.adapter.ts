import { Effect, Layer } from "effect"
import type { Checkout } from "./checkout.port.js"
import type { ReviewCache } from "./review-cache.port.js"
import type { ReviewLogs } from "./review-logs.port.js"
import type { Sandboxes } from "./sandboxes.port.js"
import { validate } from "./validate.usecase.js"
import { Validations } from "./validations.port.js"

/**
 * Validations in sandboxes (`validate`): every command of a pull request's runs in a sandbox the `Sandboxes` layer
 * makes, over a throwaway clone the `Checkout` makes, its logs kept by `ReviewLogs` and what is known between reviews
 * by `ReviewCache`.
 */
export const sandboxValidations: Layer.Layer<Validations, never, Checkout | Sandboxes | ReviewLogs | ReviewCache> = Layer.effect(Validations, Effect.gen(function* () {
  const context = yield* Effect.context<Checkout | Sandboxes | ReviewLogs | ReviewCache>()
  return Validations.of({ run: (request) => validate(request).pipe(Effect.provide(context)) })
}))
