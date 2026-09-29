import { Prompt } from "effect/ai"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Effect, Layer, Option } from "effect"
import { AuthStore, extractUsage, parseModelSelection, SettingsStore, UtilityError, UtilityLlm } from "@xandreed/core"
import { generateWith } from "./router.js"

/**
 * The fast helper tier: one-shot completions on `fastModel ?? model`. No
 * toolkit, no cache breakpoints, no loop — a title/digest call that can never
 * park a turn.
 */
export const UtilityLlmLive = Layer.effect(
  UtilityLlm,
  Effect.gen(function* () {
    const context = yield* Effect.context<AuthStore | SettingsStore>()
    const http = yield* HttpClient.HttpClient
    const settings = yield* SettingsStore

    return {
      complete: (prompt: string) =>
        Effect.gen(function* () {
          const loaded = yield* settings.load.pipe(
            Effect.mapError((e) => new UtilityError({ message: e.message })),
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
          const res = yield* generateWith(selection, {
            prompt: Prompt.make(prompt),
            tools: [],
            toolChoice: "none",
            responseFormat: { type: "text" },
          }).pipe(
            Effect.mapError((e) => new UtilityError({ message: String(e) })),
            Effect.provide(context),
            Effect.provideService(HttpClient.HttpClient, http),
          )
          const text = res.content
            .flatMap((p) => {
              const part = p as { readonly type?: string; readonly text?: string }
              return part.type === "text" ? [part.text ?? ""] : []
            })
            .join("")
          // The loop's own reading of provider usage, so both count alike.
          return { text, usage: extractUsage(res.usage, res.content) }
        }),
    }
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
