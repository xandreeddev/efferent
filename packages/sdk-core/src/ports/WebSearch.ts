import { Context, Data, type Effect } from "effect"

/** A web-search lookup failed (provider error, missing key, timeout). */
export class WebSearchError extends Data.TaggedError("WebSearchError")<{
  readonly message: string
}> {}

export interface WebSearchSource {
  readonly title: string
  readonly url: string
}

export interface WebSearchResult {
  /** A synthesized, grounded answer to the query. */
  readonly answer: string
  /** Citations backing the answer — pass a url to `web_fetch` to read it. */
  readonly sources: ReadonlyArray<WebSearchSource>
}

/**
 * Web search as a self-contained capability, deliberately decoupled from the
 * chat `LanguageModel` / `/model` selection. The adapter runs a dedicated,
 * **grounding-only** provider call (Gemini `GoogleSearch` / OpenAI `WebSearch`)
 * using its own configured key. Two consequences fall out of that design:
 *
 *  - search needs **no extra key** beyond the LLM provider key already set; and
 *  - the search request carries *only* the provider's search tool — never the
 *    agent's function tools — so it sidesteps providers (notably Gemini) that
 *    won't combine grounding with function calling in one request.
 *
 * The model uses this via the `web_search` tool to *find* things; `web_fetch`
 * then *reads* a chosen source URL in full.
 */
export class WebSearch extends Context.Tag("@xandreed/sdk-core/WebSearch")<
  WebSearch,
  {
    readonly search: (
      query: string,
    ) => Effect.Effect<WebSearchResult, WebSearchError>
  }
>() {}
