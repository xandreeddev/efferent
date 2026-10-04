import { Context } from "effect"
import type { Option } from "effect"
import type { HttpClient } from "effect/http"

/** Provider I/O only. Substituting this service retains request shaping,
 * provider decoding, retries, model descriptors and the production loop. */
export type ModelFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class ModelTransport extends Context.Service<ModelTransport, {
  readonly http: HttpClient.HttpClient
  readonly fetch: ModelFetch
  /** A Responses transport for Codex; None preserves its WebSocket transport. */
  readonly codex: Option.Option<HttpClient.HttpClient>
}>()("@xandreed/plugin-models/ModelTransport") {}
