import { describe, test } from "bun:test"
import { Effect } from "effect"
import { longTermMemoryConformance } from "@xandreed/core/conformance"
import { fixtureExtraction, fixtureScope, makeMemoryFixture } from "./memory.testing.js"

const checks = longTermMemoryConformance({ open: Effect.map(makeMemoryFixture([JSON.stringify(fixtureExtraction("I prefer tea."))]), ({ memory }) => ({ memory, scope: fixtureScope })) })

describe("native memory facade conformance", () => {
  checks.forEach((check) => test(check.name, () => Effect.runPromise(check.run)))
})
