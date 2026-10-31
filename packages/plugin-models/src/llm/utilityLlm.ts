import { Prompt, Response } from "effect/ai"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Cause, Context, Effect, Layer, Option } from "effect"
import { isTurnError, parseModelSelection, reasonOf, responseModelOf, UtilityCompletion, UtilityError, UtilityLlm } from "@xandreed/core"
import { AuthStore } from "../ports/auth-store.port.js"
import { SettingsStore } from "../ports/settings-store.port.js"
import { extractUsage } from "@xandreed/core/internal"
import { generateOver, layerProviderServices, throughTransport, withConfiguredEffort } from "./router.js"
import { CurrentModelCallPurpose } from "../ports/model-call-completion.port.js"

/**
 * The fast helper tier: one-shot completions on `fastModel ?? model`, at
 * `fastReasoningEffort ?? reasoningEffort` (the fast role, as
 * `roleModelView("fast")` reads it; a call policy the caller pinned wins).
 * No toolkit or loop; Messages uses the same per-model prompt-cache policy.
 * A helper completion cannot park a turn. Like the routed model, it reads
 * its provider services once, where it is built: over a `ModelsTransport`,
 * its calls go through it.
 *
 * @public
 */
export const UtilityLlmLive = Layer.effect(
  UtilityLlm,
  Effect.gen(function* () {
    // Replayed on every call: the store alone, so a completion's spans nest where it runs and its references are its own.
    const stores = Context.pick(AuthStore)(yield* Effect.context<AuthStore>())
    const services = yield* layerProviderServices
    const http = yield* HttpClient.HttpClient
    const settings = yield* SettingsStore

    return {
      // One `models.utility` span per completion, around the routed call's `providers.generate`.
      complete: Effect.fn("models.utility")(function* (prompt: string) {
        const loaded = yield* settings.load.pipe(
          Effect.mapError((e) => new UtilityError({ message: e.message, cause: e })),
        )
        const raw = Option.getOrElse(
          Option.orElse(loaded.fastModel, () => loaded.model),
          () => "",
        )
        const selection = yield* Option.match(parseModelSelection(raw), {
          onNone: () =>
            Effect.fail(new UtilityError({ message: "no fast/general model configured" })),
          onSome: Effect.succeed,
        })
        const res = yield* withConfiguredEffort(generateOver(services)(selection, {
          prompt: Prompt.make(prompt),
          tools: [],
          toolChoice: "none",
          responseFormat: { type: "text" },
        }), Option.orElse(loaded.fastReasoningEffort, () => loaded.reasoningEffort)).pipe(
          Effect.provideService(CurrentModelCallPurpose, "Helper"),
          // Fixed helper signatures carry the original durable-write failure as
          // a defect; the turn boundary restores it, before any soft helper catch.
          Effect.catch((error) => isTurnError(error)
            ? Effect.die(error)
            : Effect.fail(new UtilityError({ message: reasonOf(Cause.fail(error)), cause: error }))),
          // The transport's fetch innermost, as the routed model sets it (router.ts).
          throughTransport(services),
          Effect.provide(stores),
          Effect.provideService(HttpClient.HttpClient, http),
        )
        const parts = res.content.filter(Response.isPart)
        const text = parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("")
        // The loop's own reading of provider usage, so both count alike.
        const model = Option.flatMap(responseModelOf(parts), parseModelSelection)
        return new UtilityCompletion({
          text, usage: extractUsage(res.usage, parts),
          ...Option.match(model, { onNone: () => ({}), onSome: (selection) => ({ model: selection }) }),
        })
      }),
    }
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
