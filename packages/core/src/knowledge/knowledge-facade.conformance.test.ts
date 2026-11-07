import { expect, test } from "bun:test"
import { Effect, Option, Result } from "effect"
import type { Context } from "effect"
import type { LongTermMemory } from "../ports/knowledge.port.js"
import { KnowledgeError } from "./knowledge.entity.js"
import { knowledgeConformance, longTermMemoryConformance } from "./knowledge-facade.conformance.js"

const scope = { owner: "fixture", namespace: "assistant", collection: "memory" }
const careless: Context.Service.Shape<typeof LongTermMemory> = {
  capture: (input) => Effect.succeed({ id: input.jobId, scope: input.source.scope, source: input.source.ref, engine: input.engine, attempt: 0, phase: { _tag: "Queued" }, stage: Option.none() }),
  process: () => Effect.succeed(0),
  recall: () => Effect.succeed({ candidates: [], graph: { entities: [], assertions: [], truncated: false }, history: [], sources: [] }),
  profile: () => Effect.succeed([]), source: () => Effect.succeed(Option.none()), status: () => Effect.succeed(Option.none()),
  retry: () => Effect.fail(new KnowledgeError({ reason: "Conflict", message: "Nothing was recorded" })), forget: () => Effect.void,
}

test("facade kits expose stable contract names and reject a careless service on every check", async () => {
  const memory = longTermMemoryConformance({ open: Effect.succeed({ memory: careless, scope }) })
  const knowledge = knowledgeConformance({ open: Effect.succeed({ knowledge: { ...careless, ingest: careless.capture, retrieve: careless.recall }, scope }) })
  const names = ["accepted-source", "processing", "source-replay", "owner-isolation", "forget-tombstone", "source-filter", "cited-sources", "retrieval-bounds", "dropped-record"]
  expect(memory.map((check) => check.name)).toEqual(names.map((name) => `long_term_memory.${name}`))
  expect(knowledge.map((check) => check.name)).toEqual([...names, "failed-extraction"].map((name) => `knowledge_facade.${name}`))
  const results = await Effect.runPromise(Effect.forEach([...memory, ...knowledge], (check) => Effect.result(check.run), { concurrency: 1 }))
  expect(results.every(Result.isFailure)).toBe(true)
})
