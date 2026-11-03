import { describe, expect, test } from "bun:test"
import { Effect, Option, Result } from "effect"
import type { KnowledgeIndex } from "../ports/knowledge.port.js"
import { makeKnowledgeIndexMemory } from "./knowledge.memory.adapter.js"
import { knowledgeStoreConformance, temporalGraphConformance } from "./knowledge-store.conformance.js"
import { KnowledgeLeaseToken, type KnowledgeJob, type KnowledgeScope } from "./knowledge.entity.js"

const scope: KnowledgeScope = { owner: "test", namespace: "assistant", collection: "memory" }
const checks = knowledgeStoreConformance({ open: Effect.map(makeKnowledgeIndexMemory(), (index) => ({ index, scope })) })

describe("knowledge index reference conformance", () => {
  checks.forEach((check) => test(check.name, () => Effect.runPromise(check.run)))
  test("pins the checks provided to independent adapters", () => {
    expect(checks.map((check) => check.name)).toEqual([
      "knowledge.source-replay", "knowledge.lease-fencing", "knowledge.stage-retry",
      "knowledge.atomic-cas", "knowledge.exact-provenance", "knowledge.scope-isolation",
      "knowledge.hybrid-candidates", "knowledge.forget-tombstone", "knowledge.source-revision",
      "knowledge.immutable-chunk-identity", "knowledge.entity-forget-rebuild", "knowledge.forgotten-stage-privacy", "knowledge.unpublished-stage-privacy", "knowledge.pending-discovery",
      "knowledge.bitemporal-change", "knowledge.bitemporal-traversal",
    ])
  })
})

const careless = Effect.map(makeKnowledgeIndexMemory(), (real): KnowledgeIndex => ({
  ...real,
  enqueue: (input) => Effect.succeed({ id: input.jobId, scope: input.source.scope, source: input.source.ref, engine: input.engine, attempt: 0, phase: { _tag: "Queued" }, stage: Option.none() }),
  claim: (input) => Effect.map(real.pending({ engine: "kit", namespace: input.scope.namespace, now: input.now, limit: 1 }), (jobs) => Option.map(Option.fromNullishOr(jobs[0]), (job): KnowledgeJob => ({ ...job, phase: { _tag: "Processing", token: KnowledgeLeaseToken.make("ignored"), worker: "careless", leaseUntil: 999 } }))),
  stage: () => Effect.void,
  publish: () => Effect.void,
  fail: () => Effect.void,
  forget: () => Effect.void,
}))

test("every contract check rejects a careless adapter that accepts but stores nothing", async () => {
  const broken = knowledgeStoreConformance({ open: Effect.map(careless, (index) => ({ index, scope })) })
  const results = await Effect.runPromise(Effect.forEach(broken, (check) => Effect.result(check.run), { concurrency: 1 }))
  expect(results.every(Result.isFailure)).toBe(true)
})

test("the graph kit rejects a separate view that ignores the backing index", async () => {
  const graphChecks = temporalGraphConformance({ open: Effect.map(makeKnowledgeIndexMemory(), (index) => ({ index, scope, graph: { traverse: () => Effect.succeed({ entities: [], assertions: [], truncated: false }) } })) })
  expect(graphChecks.map((check) => check.name)).toEqual(["knowledge.bitemporal-change", "knowledge.bitemporal-traversal"])
  const results = await Effect.runPromise(Effect.forEach(graphChecks, (check) => Effect.result(check.run), { concurrency: 1 }))
  expect(results.every(Result.isFailure)).toBe(true)
})
