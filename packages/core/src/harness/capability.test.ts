import { test, expect } from "bun:test"
import { Effect } from "effect"
import { resolveCapabilities } from "./capability.entity.functions.js"

const tool = { id: "account", version: "1", description: "Read account", returns: "Account", permissions: ["account.read"], inputSchema: {}, outputSchema: {} }
const catalog = { version: "1", tools: [tool], recipes: [{ id: "personal", version: "1", instructions: "Read the verified account", tools: ["account"] }] }
test("recipe closure cannot bypass authorization", async () => {
  const result = await Effect.runPromise(Effect.either(resolveCapabilities(catalog, { recipes: ["personal"], tools: [] }, new Set())))
  expect(result._tag).toBe("Left")
})
test("unknown selections and ambiguous catalogs fail closed", async () => {
  expect((await Effect.runPromise(Effect.either(resolveCapabilities(catalog, { recipes: ["invented"], tools: [] }, new Set()))))._tag).toBe("Left")
  expect((await Effect.runPromise(Effect.either(resolveCapabilities({ ...catalog, tools: [tool, tool] }, { recipes: [], tools: [] }, new Set()))))._tag).toBe("Left")
})
test("selection resolves the exact catalog version and deduplicates tool closure", async () => {
  const result = await Effect.runPromise(resolveCapabilities(catalog, { recipes: ["personal"], tools: ["account", "account"] }, new Set(["account.read"])))
  expect(result.catalogVersion).toBe("1")
  expect(result.tools).toEqual([tool])
})
