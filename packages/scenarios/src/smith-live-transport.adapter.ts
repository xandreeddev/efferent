import { Effect, Layer, Match, Option, Ref, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest as HttpRequest } from "effect/http"
import type { HttpClientRequest } from "effect/http"
import { CurrentModelCallPolicy, definePlugin } from "@xandreed/core"
import { ModelTransport, OpenAiCodexWebSocketHttpClient } from "@xandreed/plugin-models"
import type { ModelFetch } from "@xandreed/plugin-models"
import { SmithPlanningTransport } from "@xandreed/smith"
import { SmithBudgetExceeded } from "./smith-budget.entity.js"
import type { makeSmithBudget } from "./smith-budget.entity.functions.js"

type Budget = Effect.Success<ReturnType<typeof makeSmithBudget>>
const requestBody = (request: HttpClientRequest.HttpClientRequest) => Match.value(request.body).pipe(
  Match.tag("Uint8Array", (body) => Effect.succeed(new TextDecoder().decode(body.body))),
  Match.tag("Raw", (body) => Schema.decodeUnknownEffect(Schema.String)(body.body).pipe(Effect.mapError(() => new SmithBudgetExceeded({ message: "Refusing unsupported raw provider request" })))),
  Match.orElse(() => Effect.fail(new SmithBudgetExceeded({ message: "Refusing uninspectable provider request" }))),
)
const providerOf = (input: RequestInfo | URL) => Effect.try({
  try: () => new URL(input instanceof Request ? input.url : String(input)),
  catch: () => new SmithBudgetExceeded({ message: "Refusing an invalid provider endpoint" }),
}).pipe(Effect.flatMap((url) => url.hostname === "opencode.ai" ? Effect.succeed("opencode") : url.hostname === "ai-gateway.vercel.sh" ? Effect.succeed("vercel") : Effect.fail(new SmithBudgetExceeded({ message: "Refusing an unadmitted provider endpoint" }))))
export const smithLiveTransport = (budget: Budget, maxOutputTokens: number, fetchImpl: ModelFetch = fetch) => Effect.gen(function* () {
  const actual = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))
  const requests = yield* Ref.make<ReadonlyArray<unknown>>([])
  const wrap = (client: HttpClient.HttpClient, provider: string) => HttpClient.mapRequestEffect(client, (request) => requestBody(request).pipe(Effect.flatMap((body) => budget.reserve(provider, body)), Effect.tap((reservation) => Ref.update(requests, (all) => [...all, { protocol: "responses", ...reservation }])), Effect.as(request), Effect.mapError((error) => new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: request.pipe(HttpRequest.setHeader("authorization", "[redacted]"), HttpRequest.setHeader("chatgpt-account-id", "[redacted]")), description: error.message }) }))))
  const providerFetch: ModelFetch = (url, init) => Effect.runPromise(providerOf(url).pipe(Effect.flatMap((provider) => budget.reserve(provider, String(init?.body))), Effect.tap((reservation) => Ref.update(requests, (all) => [...all, { protocol: "chat-completions", ...reservation }])), Effect.andThen(Effect.tryPromise({ try: () => fetchImpl(url, init), catch: () => new SmithBudgetExceeded({ message: "Provider transport failed after admission" }) }))))
  const planningFetch: ModelFetch = (url, init) => Effect.runPromise(providerOf(url).pipe(Effect.flatMap((provider) => budget.reserve(provider, String(init?.body), Option.fromNullishOr(new Headers(init?.headers).get("ai-model-id")))), Effect.tap((reservation) => Ref.update(requests, (all) => [...all, { protocol: "evaluation-model-v4", endpoint: String(url), ...reservation }])), Effect.andThen(Effect.tryPromise({ try: () => fetchImpl(url, init), catch: () => new SmithBudgetExceeded({ message: "Evaluation transport failed after admission" }) }))))
  const plugin = definePlugin({ id: "scenarios/smith-live-transport", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [ModelTransport, CurrentModelCallPolicy, SmithPlanningTransport], layer: () => Layer.mergeAll(
    Layer.succeed(ModelTransport, { http: wrap(actual, "openai"), fetch: providerFetch, codex: Option.some(wrap(OpenAiCodexWebSocketHttpClient, "openai-codex")) }),
    Layer.succeed(CurrentModelCallPolicy, Option.some({ effort: "low", maxOutputTokens })),
    Layer.succeed(SmithPlanningTransport, { fetch: planningFetch, apiKey: Option.none() }),
  ) })
  return { plugin, requests: Ref.get(requests) }
})
