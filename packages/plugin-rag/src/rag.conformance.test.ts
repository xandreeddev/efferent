import { describe, test } from "bun:test"
import { Effect } from "effect"
import { knowledgeConformance } from "@xandreed/core/conformance"
import { makeRag, scope } from "./rag.testing.js"

const checks = knowledgeConformance({ open: Effect.map(makeRag(), ({ knowledge }) => ({ knowledge, scope })) })

describe("native document facade conformance", () => {
  checks.forEach((check) => test(check.name, () => Effect.runPromise(check.run)))
})
