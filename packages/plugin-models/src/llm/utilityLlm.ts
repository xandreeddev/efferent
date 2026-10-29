import { Prompt } from "effect/ai"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Cause, Effect, Layer, Option } from "effect"
import { AuthStore, extractUsage, parseModelSelection, reasonOf, replayableContext, SettingsStore, UtilityError, UtilityLlm } from "@xandreed/core"
import { generateWith, transportFetchOf, withCodexSessions, withConfiguredEffort } from "./router.js"

/**
 * The fast helper tier: one-shot completions on `fastModel ?? model`, at
 * `fastReasoningEffort ?? reasoningEffort` (the fast role, as
 * `roleModelView("fast")` reads it; a call policy the caller pinned wins).
 * No toolkit, no cache breakpoints, no loop — a title/digest call that can
 * never park a turn. Built over a `ModelsTransport`, its calls go through it.
 */
export const UtilityLlmLive = Layer.effect(
  UtilityLlm,
  Effect.gen(function* () {
    // Replayed on every call: without the span where the layer was built, so a call's spans nest where it runs.
    const context = yield* withCodexSessions(replayableContext(yield* Effect.context<AuthStore | SettingsStore>()))
    const http = yield* HttpClient.HttpClient
    const fetch = yield* transportFetchOf
    const settings = yield* SettingsStore

    return {
      complete: (prompt: string) =>
        Effect.gen(function* () {
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
          const res = yield* withConfiguredEffort(generateWith(selection, {
            prompt: Prompt.make(prompt),
            tools: [],
            toolChoice: "none",
            responseFormat: { type: "text" },
          }), Option.orElse(loaded.fastReasoningEffort, () => loaded.reasoningEffort)).pipe(
            Effect.mapError((e) => new UtilityError({ message: reasonOf(Cause.fail(e)), cause: e })),
            // The transport's fetch innermost, as the routed model sets it (router.ts).
            (call) => Option.match(fetch, { onNone: () => call, onSome: (value) => Effect.provideService(call, FetchHttpClient.Fetch, value) }),
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
