/** Reference-only benchmark clients. No published runtime package imports this module. */
import { Clock, Effect, Option, Redacted, Schema } from "effect"
import { EvaluationError, fingerprint, unknownEvaluationUsage } from "@xandreed/evals"
import type { EvaluationEvidence, KnowledgeBackendManifest, KnowledgeEvaluationBackend, KnowledgeEvaluationInput } from "./knowledge-evaluation.js"

export interface KnowledgeReferenceDeployment {
  readonly kind: "mem0" | "graphiti" | "hindsight"
  readonly baseUrl: string
  readonly version: string
  /** Require an immutable container digest or source commit, never `latest`. */
  readonly revision: string
  readonly extractionModel: string
  readonly embeddingModel: string
  readonly embeddingVersion: string
  readonly embeddingDimensions: number
  readonly configFingerprint: string
  readonly timeoutMs: number
  readonly pollMs: number
  readonly apiKey?: Redacted.Redacted<string>
}
export type ReferenceRequest = (method: "GET" | "POST" | "DELETE", path: string, body?: Schema.Json) => Effect.Effect<unknown, EvaluationError>
const failed = (message: string, cause?: unknown) => new EvaluationError({ code: "unavailable", message, ...(cause === undefined ? {} : { cause }) })
const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError((cause) => failed("The pinned reference deployment returned an incompatible response", cause)))

/** Body size and cancellation are part of the same configured request deadline. */
const responseText = (response: Response) => Effect.acquireUseRelease(
  Effect.sync(() => response.body?.getReader()),
  (reader) => Effect.gen(function* () {
    if (!reader) return ""
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: (cause) => failed("The reference response body could not be read", cause) })
      if (chunk.done) return new TextDecoder().decode(Buffer.concat(chunks))
      size += chunk.value.byteLength
      if (size > 8 * 1024 * 1024) return yield* Effect.fail(failed("The reference response exceeds 8 MiB"))
      chunks.push(chunk.value)
    }
  }),
  (reader) => reader ? Effect.tryPromise(() => reader.cancel()).pipe(Effect.ensuring(Effect.sync(() => reader.releaseLock())), Effect.ignore({ log: "Warn", message: "Reference response cleanup failed" })) : Effect.void,
)

export const referenceRequest = (deployment: KnowledgeReferenceDeployment): ReferenceRequest => (method, path, body) => Effect.acquireUseRelease(Effect.tryPromise({
  try: (signal) => fetch(`${deployment.baseUrl.replace(/\/$/, "")}${path}`, {
    method, signal,
    headers: { "Content-Type": "application/json", ...(deployment.apiKey === undefined ? {} : deployment.kind === "mem0" ? { "X-API-Key": Redacted.value(deployment.apiKey) } : { Authorization: `Bearer ${Redacted.value(deployment.apiKey)}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), catch: (cause) => failed("The reference deployment could not be reached", cause),
}), (response) => response.ok
  ? response.status === 204 ? Effect.succeed(null) : responseText(response).pipe(Effect.flatMap((text) => text.length === 0 ? Effect.succeed(null) : decode(Schema.fromJsonString(Schema.Json), text)))
  : Effect.fail(failed(`The reference deployment refused the request with HTTP ${response.status}`)),
(response) => response.body && !response.body.locked ? Effect.tryPromise(() => response.body!.cancel()).pipe(Effect.ignore({ log: "Warn", message: "Reference response cancellation failed" })) : Effect.void).pipe(
  Effect.timeoutOrElse({ duration: deployment.timeoutMs, orElse: () => Effect.fail(failed("The reference request exceeded its configured deadline")) }),
)

const wait = (condition: Effect.Effect<boolean, EvaluationError>, deployment: KnowledgeReferenceDeployment): Effect.Effect<void, EvaluationError> => {
  const step: Effect.Effect<void, EvaluationError> = Effect.suspend(() => condition.pipe(Effect.flatMap((ready) => ready ? Effect.void : Effect.sleep(deployment.pollMs).pipe(Effect.andThen(step)))))
  return step.pipe(Effect.timeoutOrElse({ duration: deployment.timeoutMs, orElse: () => Effect.fail(failed("The reference ingestion did not become readable before its deadline")) }))
}
const Operation = Schema.Struct({ status: Schema.String })
const Receipt = Schema.Struct({ operation_id: Schema.optionalKey(Schema.NullOr(Schema.String)) })
const HindsightFact = Schema.Struct({
  id: Schema.String, text: Schema.String,
  metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  document_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  source_fact_ids: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
})
type HindsightFact = typeof HindsightFact.Type
const HindsightRecall = Schema.Struct({ results: Schema.Array(HindsightFact), source_facts: Schema.optionalKey(Schema.Record(Schema.String, HindsightFact)) })
const GraphitiFact = Schema.Struct({ uuid: Schema.String, fact: Schema.String, episodes: Schema.Array(Schema.String) })
const GraphitiRecall = Schema.Struct({ facts: Schema.Array(GraphitiFact) })
const Mem0Recall = Schema.Struct({ results: Schema.Array(Schema.Struct({ id: Schema.String, memory: Schema.String, metadata: Schema.optionalKey(Schema.NullOr(Schema.JsonObject)) })) })

/** All three clients ingest the same session text and wait for their observable processing boundary. */
export const referenceKnowledgeBackend = (deployment: KnowledgeReferenceDeployment, suppliedRequest?: ReferenceRequest): KnowledgeEvaluationBackend => {
  const protocol = { mem0: "mem0-oss-sync-rest-1", graphiti: "graphiti-reference-rest-0.31", hindsight: "hindsight-rest-retain-recall-1" }[deployment.kind]
  const manifest: KnowledgeBackendManifest = {
    id: deployment.kind, kind: "reference", engineVersion: deployment.version,
    protocolVersion: protocol, configFingerprint: fingerprint({ config: deployment.configFingerprint, revision: deployment.revision }),
    extractionModel: deployment.extractionModel, embeddingModel: deployment.embeddingModel,
    embeddingVersion: deployment.embeddingVersion, embeddingDimensions: deployment.embeddingDimensions,
  }
  const request = suppliedRequest ?? referenceRequest(deployment)
  return {
    manifest,
    open: (input: KnowledgeEvaluationInput) => Effect.gen(function* () {
      if (!deployment.revision || /^(latest|main|master)$/i.test(deployment.revision) || !deployment.configFingerprint || deployment.timeoutMs < 1 || deployment.pollMs < 1) return yield* Effect.fail(failed("Reference evaluations require a pinned revision, configuration fingerprint and positive deadlines"))
      const identity = `efferent-eval-${yield* Effect.sync(() => crypto.randomUUID())}`
      const path = `/v1/default/banks/${encodeURIComponent(identity)}`
      const episodes = yield* Effect.sync(() => input.sources.map((source) => ({ uuid: crypto.randomUUID(), source })))
      const cleanup = deployment.kind === "mem0" ? `/memories?user_id=${encodeURIComponent(identity)}` : deployment.kind === "graphiti" ? `/group/${encodeURIComponent(identity)}` : path
      yield* Effect.addFinalizer(() => request("DELETE", cleanup).pipe(Effect.ignore({ log: "Warn", message: "The temporary reference evaluation scope could not be removed" })))
      const pollOperation = (id: string) => wait(request("GET", `${path}/operations/${encodeURIComponent(id)}`).pipe(Effect.flatMap((body) => decode(Operation, body)), Effect.flatMap((operation) =>
        operation.status === "failed" || operation.status === "cancelled" ? Effect.fail(failed("Reference ingestion failed before evaluation")) : Effect.succeed(operation.status === "completed"))), deployment)
      return {
        ingest: Effect.gen(function* () {
          if (deployment.kind === "mem0") {
            yield* Effect.forEach(input.sources, (source) => request("POST", "/memories", {
              user_id: identity, messages: [{ role: "user", content: `Source date: ${new Date(source.at).toISOString()}\n${source.text}` }], metadata: { source_id: source.id, occurred_at: String(source.at) },
            }).pipe(Effect.flatMap((body) => decode(Schema.Struct({ results: Schema.Array(Schema.Json) }), body))), { concurrency: 1 })
          } else if (deployment.kind === "graphiti") {
            yield* request("POST", "/messages", { group_id: identity, messages: episodes.map(({ uuid, source }) => ({ uuid, name: source.id, content: source.text, role_type: "user", role: "conversation", timestamp: new Date(source.at).toISOString(), source_description: "evaluation transcript" })) })
            yield* wait(request("GET", `/episodes/${encodeURIComponent(identity)}?last_n=${episodes.length}`).pipe(
              Effect.flatMap((body) => decode(Schema.Array(Schema.Struct({ uuid: Schema.String })), body)),
              Effect.map((visible) => episodes.every((episode) => visible.some((item) => item.uuid === episode.uuid))),
            ), deployment)
          } else {
            yield* Effect.forEach(input.sources, (source) => Effect.gen(function* () {
              const operationId = yield* Effect.sync(() => crypto.randomUUID())
              const receipt = yield* request("POST", `${path}/memories`, { async: true, operation_id: operationId, items: [{ content: source.text, document_id: source.id, timestamp: new Date(source.at).toISOString(), metadata: { source_id: source.id } }] }).pipe(Effect.flatMap((body) => decode(Receipt, body)))
              if (!receipt.operation_id) return yield* Effect.fail(failed("Hindsight did not acknowledge an asynchronous ingestion operation"))
              yield* pollOperation(receipt.operation_id)
            }), { concurrency: 1 })
            const consolidation = yield* request("POST", `${path}/consolidate`, {}).pipe(Effect.flatMap((body) => decode(Receipt, body)))
            if (consolidation.operation_id) yield* pollOperation(consolidation.operation_id)
          }
          return { usage: unknownEvaluationUsage }
        }),
        recall: (budget) => Effect.gen(function* () {
          if (deployment.kind === "mem0") {
            const response = yield* request("POST", "/search", { query: input.question, filters: { user_id: identity }, top_k: budget.topK }).pipe(Effect.flatMap((body) => decode(Mem0Recall, body)))
            return { items: response.results.map((memory): EvaluationEvidence => ({ id: memory.id, text: memory.memory, sources: typeof memory.metadata?.source_id === "string" ? [memory.metadata.source_id] : [] })), usage: unknownEvaluationUsage }
          }
          if (deployment.kind === "graphiti") {
            const response = yield* request("POST", "/search", { query: input.question, group_ids: [identity], max_facts: budget.topK }).pipe(Effect.flatMap((body) => decode(GraphitiRecall, body)))
            return { items: response.facts.map((fact): EvaluationEvidence => ({ id: fact.uuid, text: fact.fact, sources: episodes.filter((episode) => fact.episodes.includes(episode.uuid)).map((episode) => episode.source.id) })), usage: unknownEvaluationUsage }
          }
          const response = yield* request("POST", `${path}/memories/recall`, { query: input.question, max_tokens: budget.contextTokens, budget: "high", query_timestamp: new Date(input.queryAt).toISOString(), include: { source_facts: { max_tokens: budget.contextTokens } } }).pipe(Effect.flatMap((body) => decode(HindsightRecall, body)))
          const sourceIds = (fact: HindsightFact): ReadonlyArray<string> => {
            const own = fact.metadata?.source_id ?? fact.document_id
            return own ? [own] : (fact.source_fact_ids ?? []).flatMap((id) => {
              const source = response.source_facts?.[id]
              const sourceId = source?.metadata?.source_id ?? source?.document_id
              return sourceId ? [sourceId] : []
            })
          }
          return { items: response.results.map((fact): EvaluationEvidence => ({ id: fact.id, text: fact.text, sources: [...new Set(sourceIds(fact))] })), usage: unknownEvaluationUsage }
        }),
      }
    }),
  }
}
