import { Prompt } from "@effect/ai"
import { FetchHttpClient, HttpClient } from "@effect/platform"
import { Effect, Layer, Option } from "effect"
import {
  AuthStore,
  parseModelSelection,
  SettingsStore,
  UtilityError,
  UtilityLlm,
} from "@xandreed/engine"
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
          const usage = res.usage as
            | {
                readonly inputTokens?: number
                readonly outputTokens?: number
                readonly totalTokens?: number
                readonly cachedInputTokens?: number
              }
            | undefined
          return {
            text,
            usage: {
              inputTokens: usage?.inputTokens ?? 0,
              outputTokens: usage?.outputTokens ?? 0,
              totalTokens: usage?.totalTokens ?? 0,
              cacheReadTokens: usage?.cachedInputTokens ?? 0,
            },
          }
        }),
    }
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
