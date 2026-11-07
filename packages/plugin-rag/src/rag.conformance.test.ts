import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { UtilityCompletion, UtilityLlm, zeroUsage } from "@xandreed/core"
import { knowledgeConformance } from "@xandreed/core/conformance"
import { makeRag, scope } from "./rag.testing.js"

const invalidHelper = UtilityLlm.of({ complete: () => Effect.succeed(new UtilityCompletion({ text: "not JSON", usage: zeroUsage })) })
const tea = { start: 9, end: 12, quote: "tea" }
/** A grounded entity and relation for the kit's source, "I prefer tea.", and a relation about an entity the extraction never defines. */
const droppingHelper = UtilityLlm.of({ complete: () => Effect.succeed(new UtilityCompletion({ usage: zeroUsage, text: JSON.stringify({
  entities: [{ key: "tea", name: "tea", type: "drink", aliases: [], existing: null, spans: [tea] }], memories: [],
  assertions: ["tea", "stranger"].map((subject) => ({ key: subject, subject, predicate: "preferred", object: { _tag: "Value", value: true }, text: "Tea is preferred.", spans: [tea], validFrom: null, validTo: null, supersedes: [], supersession: "correction" })),
}) })) })
const checks = knowledgeConformance({
  open: Effect.map(makeRag(), ({ knowledge }) => ({ knowledge, scope })),
  droppingExtraction: Effect.map(makeRag({ graph: true, review: "off" }, undefined, undefined, droppingHelper), ({ knowledge }) => ({ knowledge, scope })),
  failingExtraction: Effect.map(makeRag({ graph: true, maxAttempts: 2 }, undefined, undefined, invalidHelper), ({ knowledge }) => ({ knowledge, scope })),
})

describe("native document facade conformance", () => {
  checks.forEach((check) => test(check.name, () => Effect.runPromise(check.run)))
  test("the source-filter check rejects retrieval that ignores the filter", async () => {
    const unfiltered = knowledgeConformance({ open: Effect.map(makeRag(), ({ knowledge }) => ({ knowledge: { ...knowledge, retrieve: ({ sources: _ignored, ...input }) => knowledge.retrieve(input) }, scope })) })
      .filter((check) => check.name === "knowledge_facade.source-filter")
    const results = await Effect.runPromise(Effect.forEach(unfiltered, (check) => Effect.result(check.run), { concurrency: 1 }))
    expect(results.length === 1 && results.every(Result.isFailure)).toBe(true)
  })
})
