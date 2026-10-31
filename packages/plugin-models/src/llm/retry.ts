import { AiError } from "effect/ai"
import { HttpClientError } from "effect/http"
import { Effect, Option, Predicate, Stream } from "effect"
import { CurrentEmptyResponseTolerance, modelFailureOf, stampAiErrorFailure } from "@xandreed/core"
import { modelRetryDefaults } from "./model-retry-policy.entity.js"

/** Default request/header bound; configure CurrentModelRetryPolicy per call. @public */
export const LLM_REQUEST_TIMEOUT_MS = modelRetryDefaults.requestTimeoutMs
/** Default total request budget, shared with a configured fallback. @public */
export const LLM_CALL_BUDGET_MS = modelRetryDefaults.totalTimeoutMs

export type ErrorClass = "transient" | "permanent"

/** Semantic fallback eligibility. HTTP retries and Retry-After waits belong to the request policy. */
export const classifyLlmError = (error: unknown, _now = 0): ErrorClass => {
  const failure = modelFailureOf(error)
  if (Option.exists(failure, (kind) => ["ContextOverflow", "Authentication", "InvalidRequest", "Quota", "InvalidResponse"].includes(kind))) return "permanent"
  if (Option.exists(failure, (kind) => ["RateLimit", "Transient", "Timeout"].includes(kind))) return "transient"
  if (!AiError.isAiError(error)) return HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError" ? "transient" : "permanent"
  const reason = error.reason
  const response = "http" in reason ? reason.http?.response : undefined
  if (response !== undefined) return response.status === 429 || response.status >= 500 ? "transient" : "permanent"
  return reason._tag === "InternalProviderError" || reason._tag === "NetworkError" || reason._tag === "UnknownError" ? "transient" : "permanent"
}

const emptyError = (label: string, method: string): AiError.AiError => stampAiErrorFailure(AiError.make({
  module: "Router", method,
  reason: new AiError.UnknownError({ description: `${label} returned an empty response (no text, tool call, or reasoning) — treated as a transient provider failure` }),
}), "Transient")

const partType = (part: unknown): string =>
  Predicate.hasProperty(part, "type") && Predicate.isString(part.type) ? part.type : ""

const isContentPart = (part: unknown): boolean => {
  const type = partType(part)
  return type === "text" || type === "tool-call" || type === "reasoning"
}

/** Reject an HTTP-200-but-empty response instead of fake-completing
 *  the turn — UNLESS the loop has declared tolerance
 *  ({@link CurrentEmptyResponseTolerance}): once a run has executed tool
 *  calls, a following empty response is the model finishing. */
export const rejectEmptyResponse =
  (label: string) =>
  <A extends { readonly content: ReadonlyArray<unknown> }, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | AiError.AiError, R> =>
    Effect.service(CurrentEmptyResponseTolerance).pipe(
      Effect.flatMap((tolerant) =>
        tolerant
          ? effect
          : effect.pipe(
            Effect.filterOrFail(
              (res) => Option.isSome(modelFailureOf(res.content)) || res.content.some(isContentPart),
              () => emptyError(label, "generateText"),
            ),
          ),
      ),
    )

/** A part that carries its provider's metadata (a thinking block's signature, a redacted block's data). */
const carriesMetadata = (part: unknown): boolean =>
  Predicate.hasProperty(part, "metadata") && Predicate.isObject(part.metadata) && Object.keys(part.metadata).length > 0

/** Content-part identity, on the stream vocabulary: a non-empty
 *  text/reasoning delta, a tool call, or a reasoning part that carries
 *  provider metadata (a signature-only delta, a redacted block's start),
 *  which the stream fold keeps as content. The empty guard counts it — S1 guarantees empty deltas never reach here. */
const isStreamContentPart = (part: unknown): boolean => {
  const type = partType(part)
  if (type === "tool-call") return true
  if ((type === "reasoning-start" || type === "reasoning-delta" || type === "reasoning-end") && carriesMetadata(part)) return true
  return (
    (type === "text-delta" || type === "reasoning-delta") &&
    Predicate.hasProperty(part, "delta") &&
    Predicate.isString(part.delta) &&
    part.delta.length > 0
  )
}

const isFinishPart = (part: unknown): boolean => partType(part) === "finish"


/** Preserve streamed content and semantic failures; reject an empty finish without replaying its request. */
export const rejectEmptyStream = (label: string) => <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E | AiError.AiError, R> =>
  Stream.unwrap(Effect.map(Effect.service(CurrentEmptyResponseTolerance), (tolerant) => tolerant ? stream : stream.pipe(
    Stream.mapAccumEffect(() => false, (seen, part) => {
      const content = seen || Option.isSome(modelFailureOf(part)) || isStreamContentPart(part)
      return !content && isFinishPart(part) ? Effect.fail(emptyError(label, "streamText")) : Effect.succeed([content, [part]] as const)
    }),
  )))
