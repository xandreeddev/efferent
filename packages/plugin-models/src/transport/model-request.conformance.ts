import { Effect, Exit, Option, Ref } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { modelFailureOf } from "@xandreed/core"
import { check, ConformanceFailure } from "@xandreed/core/conformance"
import type { ConformanceCheck } from "@xandreed/core/conformance"
import { modelRetryDefaults } from "../llm/model-retry-policy.entity.js"
import { CurrentModelRetryPolicy } from "../ports/model-retry-policy.port.js"
import { resilientRequest } from "./resilient-http-client.adapter.js"
import type { ResilientHttpError, ResilientHttpResponse } from "./resilient-http-client.adapter.js"
import type { ProviderFailureProtocol } from "../llm/provider-failure.entity.js"

/** A fresh logical request over a supplied raw transport; request retries belong to the subject. @public */
export interface ModelRequestSubject {
  readonly request: (client: HttpClient.HttpClient, request: HttpClientRequest.HttpClientRequest, options: { readonly protocol: ProviderFailureProtocol }) => Effect.Effect<Pick<ResilientHttpResponse, "text" | "status">, ResilientHttpError>
}
const policy = { ...modelRetryDefaults, totalTimeoutMs: 2000, requestTimeoutMs: 100, bodyIdleTimeoutMs: 100, backoff: { initialMs: 0, maxMs: 0, jitter: 0 } }
const request = HttpClientRequest.post("https://conformance.invalid/messages").pipe(HttpClientRequest.bodyJsonUnsafe({ fixture: true }))
const expect = (id: string, holds: boolean, message: string) => holds ? Effect.void : Effect.fail(new ConformanceFailure({ check: id, message }))
const response = (request: HttpClientRequest.HttpClientRequest, status: number, type: string) => HttpClientResponse.fromWeb(request, Response.json({ error: { type, message: "conformance fixture" } }, { status }))

/** Bounded request-policy contract, independent of provider credentials or a real network. @public */
export const modelRequestConformance = (subject: ModelRequestSubject = { request: resilientRequest }): ReadonlyArray<ConformanceCheck> => [
  check("uses one counter for transport failures and rejected statuses", "mixed-attempts", () => Effect.gen(function* () {
    const sends = yield* Ref.make(0)
    const client = HttpClient.make((request) => Effect.flatMap(Ref.getAndUpdate(sends, (n) => n + 1), (ordinal) => ordinal === 0
      ? Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "fixture" }) }))
      : Effect.succeed(ordinal < 3 ? response(request, ordinal === 1 ? 429 : 529, ordinal === 1 ? "rate_limit_error" : "overloaded_error") : HttpClientResponse.fromWeb(request, new Response("ok")))))
    const result = yield* subject.request(client, request, { protocol: "anthropic" }).pipe(Effect.flatMap((reply) => reply.text), Effect.provideService(CurrentModelRetryPolicy, policy))
    yield* expect("mixed-attempts", result === "ok" && (yield* Ref.get(sends)) === 4, "mixed failures did not reach one fourth-attempt success")
  })),
  check("classifies a structured permanent error before retrying its status", "permanent-status", () => Effect.gen(function* () {
    const sends = yield* Ref.make(0)
    const client = HttpClient.make((request) => Ref.update(sends, (n) => n + 1).pipe(Effect.as(response(request, 429, "invalid_request_error"))))
    const result = yield* Effect.exit(subject.request(client, request, { protocol: "compat" }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    yield* expect("permanent-status", Exit.isFailure(result) && (yield* Ref.get(sends)) === 1 && Option.contains(modelFailureOf(result.cause.reasons.find((reason) => reason._tag === "Fail")?.error), "InvalidRequest"), "a permanent request error was retried or lost its semantic kind")
  })),
  check("reads a call's policy at execution and obeys its total attempt limit", "dynamic-policy", () => Effect.gen(function* () {
    const run = (maxAttempts: number) => Effect.gen(function* () {
      const sends = yield* Ref.make(0)
      const client = HttpClient.make((request) => Ref.update(sends, (n) => n + 1).pipe(Effect.as(response(request, 503, "overloaded_error"))))
      yield* Effect.exit(subject.request(client, request, { protocol: "anthropic" }).pipe(Effect.provideService(CurrentModelRetryPolicy, { ...policy, maxAttempts })))
      return yield* Ref.get(sends)
    })
    const one = yield* run(1)
    const three = yield* run(3)
    yield* expect("dynamic-policy", one === 1 && three === 3, "a call ignored its policy or repeated beyond its total attempt cap")
  })),
  check("never sends a settled request again after its pending headers time out", "settled-headers", () => Effect.gen(function* () {
    // A settled response's headers come with the whole generation: a second send would generate (and bill) it again.
    const sends = yield* Ref.make(0)
    const client = HttpClient.make(() => Ref.update(sends, (n) => n + 1).pipe(Effect.andThen(Effect.never)))
    const result = yield* subject.request(client, request, { protocol: "anthropic" }).pipe(
      Effect.provideService(CurrentModelRetryPolicy, { ...policy, requestTimeoutMs: 50, totalTimeoutMs: 300 }),
      Effect.exit, Effect.timeoutOption("2 seconds"),
    )
    const timedOut = Option.exists(result, (exit) => Exit.isFailure(exit) && Option.contains(modelFailureOf(exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error), "Timeout"))
    yield* expect("settled-headers", timedOut && (yield* Ref.get(sends)) === 1, "a settled request was cut before its deadline and sent again, or never timed out")
  })),
  check("reads a successful body that loses its connection as a transient failure", "lost-body", () => Effect.gen(function* () {
    const client = HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, new Response(new ReadableStream({ start(controller) { controller.error(new Error("conformance connection reset")) } })))))
    const result = yield* subject.request(client, request, { protocol: "anthropic" }).pipe(Effect.flatMap((reply) => reply.text), Effect.exit, Effect.provideService(CurrentModelRetryPolicy, policy))
    yield* expect("lost-body", Exit.isFailure(result) && Option.contains(modelFailureOf(result.cause.reasons.find((reason) => reason._tag === "Fail")?.error), "Transient"), "a lost connection after handoff became a permanent or unclassified failure")
  })),
]
