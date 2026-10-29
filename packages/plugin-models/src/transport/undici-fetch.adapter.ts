import type { Dispatcher } from "undici"
import type { ModelsFetch } from "../ports/models-transport.port.js"

/**
 * undici's `fetch` through `dispatcher`, typed as the global `fetch`. The
 * npm undici's requests and responses have the shape of the global fetch
 * types, but are distinct classes (Node's own fetch is a bundled undici of
 * its own), and undici declares its own `Headers`, `Blob` and streams. So
 * nothing downstream may rely on `instanceof Response` or `Headers`: effect's
 * `FetchHttpClient`, the OpenAI-compatible client and the OAuth requests
 * read them by shape. This file
 * is the type-erasure boundary between the two declarations.
 */
export const undiciFetch = (fetch: typeof import("undici").fetch, dispatcher: Dispatcher): ModelsFetch =>
  (input, init) => fetch(input, { ...init, dispatcher } as never) as never
