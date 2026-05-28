import { Http, HttpError } from "@agent/core"
import { Effect, Layer } from "effect"

/**
 * `Http` port via the runtime's global `fetch` (Bun). Non-2xx responses are
 * returned (status + body) rather than thrown — only transport failures map
 * to `HttpError`. The body is capped at `maxBytes` to bound tool output.
 */
export const HttpLive = Layer.succeed(Http, {
  get: (url, options) =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetch(url, {
          headers: {
            "user-agent": "xandreed-agent/0.1 (+https://xandreed.dev)",
            accept: "text/html,application/json,text/plain,*/*",
          },
          redirect: "follow",
        })
        const contentType = res.headers.get("content-type") ?? ""
        const maxBytes = options?.maxBytes ?? 50_000
        const text = await res.text()
        return {
          status: res.status,
          contentType,
          body: text.length > maxBytes ? text.slice(0, maxBytes) : text,
        }
      },
      catch: (cause) =>
        new HttpError({
          url,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),
})
