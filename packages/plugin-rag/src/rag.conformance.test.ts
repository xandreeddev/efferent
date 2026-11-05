import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { knowledgeConformance } from "@xandreed/core/conformance"
import { makeRag, scope } from "./rag.testing.js"

const checks = knowledgeConformance({ open: Effect.map(makeRag(), ({ knowledge }) => ({ knowledge, scope })) })

describe("native document facade conformance", () => {
  checks.forEach((check) => test(check.name, () => Effect.runPromise(check.run)))
  test("the source-filter check rejects retrieval that ignores the filter", async () => {
    const unfiltered = knowledgeConformance({ open: Effect.map(makeRag(), ({ knowledge }) => ({ knowledge: { ...knowledge, retrieve: ({ sources: _ignored, ...input }) => knowledge.retrieve(input) }, scope })) })
      .filter((check) => check.name === "knowledge_facade.source-filter")
    const results = await Effect.runPromise(Effect.forEach(unfiltered, (check) => Effect.result(check.run), { concurrency: 1 }))
    expect(results.length === 1 && results.every(Result.isFailure)).toBe(true)
  })
})
