import { Prompt, Response, type Tool, Toolkit } from "@effect/ai"
import { GoogleClient, GoogleLanguageModel, GoogleTool } from "@effect/ai-google"
import { OpenAiClient, OpenAiLanguageModel, OpenAiTool } from "@effect/ai-openai"
import {
  parseModel,
  type Provider,
  WebSearch,
  WebSearchError,
  type WebSearchResult,
  type WebSearchSource,
} from "@efferent/core"
import { Config, Effect, Layer, Option } from "effect"
import { GOOGLE_API_KEY, hasKey, OPENAI_API_KEY } from "./clients.js"

/**
 * `WebSearch` backed by a provider's **server-side** search tool — Gemini
 * `GoogleSearch` grounding or OpenAI `WebSearch`. Each `search` is a dedicated,
 * grounding-only `generateText` call: the request carries *only* the search
 * tool (no function tools), so it works with no extra key beyond the LLM
 * provider key and never trips providers that won't mix grounding with
 * function calling. The result's synthesized text is the answer; the response's
 * `source` parts are the citations.
 *
 * The search engine is configured independently of the chat `/model`:
 *  - `EFFERENT_SEARCH_MODEL` ("<provider>:<modelId>", e.g. `google:gemini-3.5-flash`
 *    or `openai:gpt-4o`) pins it explicitly; otherwise
 *  - it defaults to whichever provider key is present (Google preferred).
 * With no provider key set, `search` fails with a clear, returned tool error.
 */

const DEFAULT_GOOGLE_SEARCH_MODEL = "gemini-3.5-flash"
const DEFAULT_OPENAI_SEARCH_MODEL = "gpt-4o"

interface SearchModel {
  readonly provider: Provider
  readonly modelId: string
}

const resolveSearchModel: Effect.Effect<SearchModel | undefined> = Effect.gen(
  function* () {
    const explicit = yield* Config.string("EFFERENT_SEARCH_MODEL").pipe(
      Config.option,
      Effect.orElseSucceed(() => Option.none<string>()),
    )
    if (Option.isSome(explicit) && explicit.value.trim().length > 0) {
      return parseModel(explicit.value.trim())
    }
    if (yield* hasKey(GOOGLE_API_KEY)) {
      return { provider: "google", modelId: DEFAULT_GOOGLE_SEARCH_MODEL }
    }
    if (yield* hasKey(OPENAI_API_KEY)) {
      return { provider: "openai", modelId: DEFAULT_OPENAI_SEARCH_MODEL }
    }
    return undefined
  },
)

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
    const google = yield* GoogleClient.GoogleClient
    const openai = yield* OpenAiClient.OpenAiClient
    const sel = yield* resolveSearchModel

    const search = (
      query: string,
    ): Effect.Effect<WebSearchResult, WebSearchError> => {
      if (sel === undefined) {
        return Effect.fail(
          new WebSearchError({
            message:
              "Web search is not configured — set GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY (or EFFERENT_SEARCH_MODEL).",
          }),
        )
      }

      const prompt = Prompt.make([
        { role: "user", content: searchPrompt(query) },
      ] as never)

      // Each provider branch keeps its own concretely-typed, handler-free
      // search toolkit — no union, no cast. Both yield a WebSearchResult.
      const run =
        sel.provider === "google"
          ? Effect.gen(function* () {
              const svc = yield* GoogleLanguageModel.make({
                model: sel.modelId,
              }).pipe(Effect.provideService(GoogleClient.GoogleClient, google))
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
              const svc = yield* OpenAiLanguageModel.make({
                model: sel.modelId,
              }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, openai))
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
        Effect.mapError((e) => new WebSearchError({ message: errorMessage(e) })),
      )
    }

    return { search }
  }),
)
