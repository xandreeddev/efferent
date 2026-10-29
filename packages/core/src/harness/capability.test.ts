import { test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { strictJsonSchema, toolParametersSchema } from "../loop/toolSchema.js"
import { catalogOf, defineCapability, defineSkill, defineTool, resolveCapabilities } from "./capability.entity.functions.js"

const tool = { id: "account", version: "1", description: "Read account", returns: "Account", permissions: ["account.read"], inputSchema: {}, outputSchema: {} }
const catalog = { version: "1", tools: [tool], recipes: [{ id: "personal", version: "1", instructions: "Read the verified account", tools: ["account"] }] }
test("recipe closure cannot bypass authorization", async () => {
  const result = await Effect.runPromise(Effect.result(resolveCapabilities(catalog, { recipes: ["personal"], tools: [] }, new Set())))
  expect(result._tag).toBe("Failure")
})
test("unknown selections and ambiguous catalogs fail closed", async () => {
  expect((await Effect.runPromise(Effect.result(resolveCapabilities(catalog, { recipes: ["invented"], tools: [] }, new Set()))))._tag).toBe("Failure")
  expect((await Effect.runPromise(Effect.result(resolveCapabilities({ ...catalog, tools: [tool, tool] }, { recipes: [], tools: [] }, new Set()))))._tag).toBe("Failure")
})
test("selection resolves the exact catalog version and deduplicates tool closure", async () => {
  const result = await Effect.runPromise(resolveCapabilities(catalog, { recipes: ["personal"], tools: ["account", "account"] }, new Set(["account.read"])))
  expect(result.catalogVersion).toBe("1")
  expect(result.tools).toEqual([tool])
})
test("an always-on skill takes no instructions: nothing would show them to the model", () => {
  // @ts-expect-error -- an always-on skill is never loaded, so its instructions could never reach the model.
  const refused = defineSkill({ id: "style", summary: "House style.", instructions: "Write short sentences.", tools: [], always: true })
  const always = defineSkill({ id: "core", summary: "Look records up.", tools: ["lookup"], always: true })
  const loadable = defineSkill({ id: "delivery", summary: "Deliver a final answer.", instructions: "Deliver once.", tools: ["deliver"] })
  const either = (on: boolean) => defineSkill({ id: "read", summary: "Read files.", tools: ["read"], always: on })
  expect([refused.always, always.always, always.instructions, loadable.always, loadable.instructions, either(true).always]).toEqual([true, true, "", false, "Deliver once.", true])
})
test("the catalogue holds each tool's parameter and result schemas as JSON", async () => {
  const Lookup = Tool.make("lookup", { parameters: Schema.Struct({ query: Schema.String, page: Schema.optional(Schema.Int) }), success: Schema.Struct({ id: Schema.String }) })
  const records = defineCapability({ id: "records", version: "1", tools: [defineTool({ tool: Lookup, handler: () => Effect.succeed({ id: "a" }) })] })
  const [listed] = (await Effect.runPromise(catalogOf("1", [records]))).tools
  expect([listed?.id, Schema.is(Schema.JsonObject)(listed?.inputSchema), Schema.is(Schema.JsonObject)(listed?.outputSchema)]).toEqual(["lookup", true, true])
  expect<ReadonlyArray<unknown>>([listed?.inputSchema, listed?.outputSchema]).toEqual([toolParametersSchema(Lookup), strictJsonSchema(Lookup.successSchema)])
})
