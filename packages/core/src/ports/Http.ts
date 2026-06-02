import { Context, Data, type Effect } from "effect"

/** A network fetch failed (DNS, TLS, timeout, non-2xx is still returned). */
export class HttpError extends Data.TaggedError("HttpError")<{
  readonly url: string
  readonly message: string
}> {}

export interface HttpGetResult {
  readonly status: number
  readonly contentType: string
  readonly body: string
}

/**
 * Minimal outbound HTTP capability for tools (e.g. `web_fetch`). Kept as a
 * port so `core` stays IO-free; the adapter wraps `fetch`/`HttpClient`.
 */
export class Http extends Context.Tag("@efferent/core/Http")<
  Http,
  {
    readonly get: (
      url: string,
      options?: { readonly maxBytes?: number },
    ) => Effect.Effect<HttpGetResult, HttpError>
  }
>() {}
