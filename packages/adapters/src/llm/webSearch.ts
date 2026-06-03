import { Prompt, type Response, type Tool, Toolkit } from "@effect/ai"
import { GoogleClient, GoogleLanguageModel, GoogleTool } from "@effect/ai-google"
import { OpenAiClient, OpenAiLanguageModel, OpenAiTool } from "@effect/ai-openai"
import { HttpClient } from "@effect/platform"
import {
  AuthStore,
  parseModel,
  type Provider,
  SettingsStore,
  WebSearch,
  WebSearchError,
  type WebSearchResult,
  type WebSearchSource,
} from "@efferent/core"
import { Config, Effect, Layer, Option } from "effect"

/**
 * `WebSearch` backed by a provider's **server-side** search tool — Gemini
 * `GoogleSearch` grounding or OpenAI `WebSearch`. Each `search` is a dedicated,
 * grounding-only `generateText` call: the request carries *only* the search
 * tool (no function tools), so it never trips providers that won't mix
 * grounding with function calling. The result's synthesized text is the
 * answer; the response's `source` parts are the citations.
 *
 * The search engine is configured independently of the chat `/model`:
 *  - `:set searchModel <provider>:<modelId>` (google/openai only) pins it;
 *  - `EFFERENT_SEARCH_MODEL` is still honored as a fallback; otherwise
 *  - it defaults to whichever provider is logged in via `:login` (Google
 *    preferred). The key is resolved per search from the `AuthStore`.
 * With neither Google nor OpenAI configured, `search` fails with a clear,
 * returned tool error.
 */

const DEFAULT_GOOGLE_SEARCH_MODEL = "gemini-3.5-flash"
const DEFAULT_OPENAI_SEARCH_MODEL = "gpt-4o"

interface SearchModel {
  readonly provider: Provider
  readonly modelId: string
}

const parseSearchModel = (raw: string): SearchModel | undefined => {
  const value = raw.trim()
  if (value.length === 0) return undefined
  const idx = value.indexOf(":")
  if (idx > 0) {
    const provider = value.slice(0, idx)
    if (provider !== "google" && provider !== "openai") return undefined
  }
  const m = parseModel(value)
  // Only Google/OpenAI expose a server-side search tool here.
  return m.provider === "google" || m.provider === "openai" ? m : undefined
}

const resolveSearchModel = (
  auth: AuthStore["Type"],
  settingsStore: SettingsStore["Type"],
): Effect.Effect<SearchModel | undefined> =>
  Effect.gen(function* () {
    const settings = yield* settingsStore.get()
    const fromSettings = settings.searchModel !== undefined
      ? parseSearchModel(settings.searchModel)
      : undefined
    if (fromSettings !== undefined) return fromSettings

    const explicit = yield* Config.string("EFFERENT_SEARCH_MODEL").pipe(
      Config.option,
      Effect.orElseSucceed(() => Option.none<string>()),
    )
    if (Option.isSome(explicit)) {
      const fromEnv = parseSearchModel(explicit.value)
      if (fromEnv !== undefined) return fromEnv
    }

    if ((yield* auth.get("google")) !== undefined) {
      return { provider: "google", modelId: DEFAULT_GOOGLE_SEARCH_MODEL }
    }
    const openai = yield* auth.get("openai")
    if (openai?.type === "api_key") {
      return { provider: "openai", modelId: DEFAULT_OPENAI_SEARCH_MODEL }
    }
    return undefined
  })

const searchPrompt = (query: string): string =>
  `Search the web and answer with up-to-date, factual information. Be concise — a short paragraph or a few bullets. Rely on the search results; if they conflict, say so briefly.\n\nQuery: ${query}`

/**
 * Pull the grounding citations out of a response's `source` parts. Generic
 * over the toolkit's tools so it works for either provider's response without
 * a cast — `UrlSourcePart` is provider-agnostic. Deduped by URL, order kept.
 */
const extractSources = <T extends Record<string, Tool.Any>>(
  content: ReadonlyArray<Response.Part<T>>,
): WebSearchSource[] => {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const part of content) {
    if (part.type !== "source" || part.sourceType !== "url") continue
    const url = part.url.toString()
    if (seen.has(url)) continue
    seen.add(url)
    sources.push({ title: part.title.length > 0 ? part.title : url, url })
  }
  return sources
}

const errorMessage = (e: unknown): string => {
  if (typeof e === "object" && e !== null) {
    const o = e as { message?: unknown; _tag?: unknown }
    if (typeof o.message === "string" && o.message.length > 0) return o.message
    if (typeof o._tag === "string") return o._tag
  }
  return String(e)
}

export const WebSearchLive = Layer.effect(
  WebSearch,
  Effect.gen(function* () {
    const auth = yield* AuthStore
    const settingsStore = yield* SettingsStore
    const http = yield* HttpClient.HttpClient

    const search = (
      query: string,
    ): Effect.Effect<WebSearchResult, WebSearchError> =>
      resolveSearchModel(auth, settingsStore).pipe(
        Effect.flatMap((sel) => {
          if (sel === undefined) {
            return Effect.fail(
              new WebSearchError({
                message:
                  "Web search is not configured — log in to Google or OpenAI with :login (or set :set searchModel ... / EFFERENT_SEARCH_MODEL).",
              }),
            )
          }

          const prompt = Prompt.make([
            { role: "user", content: searchPrompt(query) },
          ] as never)

          // Each provider branch keeps its own concretely-typed, handler-free
          // search toolkit — no union, no cast. The client is built per call
          // from the resolved key (scoped to the call).
          const run =
            sel.provider === "google"
              ? Effect.gen(function* () {
                  const key = yield* auth
                    .resolveKey("google")
                    .pipe(Effect.orElseSucceed(() => undefined))
                  const client = yield* GoogleClient.make({ apiKey: key })
                  const svc = yield* GoogleLanguageModel.make({
                    model: sel.modelId,
                  }).pipe(Effect.provideService(GoogleClient.GoogleClient, client))
                  const res = yield* svc.generateText({
                    prompt,
                    toolkit: Toolkit.make(GoogleTool.GoogleSearch({})),
                  })
                  return {
                    answer: res.text,
                    sources: extractSources(res.content),
                  } satisfies WebSearchResult
                })
              : Effect.gen(function* () {
                  const key = yield* auth
                    .resolveKey("openai")
                    .pipe(Effect.orElseSucceed(() => undefined))
                  const client = yield* OpenAiClient.make({ apiKey: key })
                  const svc = yield* OpenAiLanguageModel.make({
                    model: sel.modelId,
                  }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client))
                  const res = yield* svc.generateText({
                    prompt,
                    toolkit: Toolkit.make(OpenAiTool.WebSearch({})),
                  })
                  return {
                    answer: res.text,
                    sources: extractSources(res.content),
                  } satisfies WebSearchResult
                })

          return run.pipe(
            Effect.scoped,
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.mapError((e) => new WebSearchError({ message: errorMessage(e) })),
          )
        }),
      )

    return { search }
  }),
)
