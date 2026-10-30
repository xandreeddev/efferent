import { test, expect } from "bun:test"
import { Context, Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { strictJsonSchema, toolParametersSchema } from "../loop/toolSchema.js"
import { SessionEnvironment } from "../ports/harness.port.js"
import { catalogOf, defineCapability, defineSkill, defineTool, resolveCapabilities } from "./capability.entity.functions.js"
import { CapabilityToolId, SkillId } from "./capability.entity.js"

const tool = { id: CapabilityToolId.make("account"), version: "1", description: "Read account", returns: "Account", permissions: ["account.read"], inputSchema: {}, outputSchema: {} }
const catalog = { version: "1", tools: [tool], recipes: [{ id: SkillId.make("personal"), version: "1", instructions: "Read the verified account", tools: ["account"] }] }
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
  expect<ReadonlyArray<unknown>>([listed?.id, Schema.is(Schema.JsonObject)(listed?.inputSchema), Schema.is(Schema.JsonObject)(listed?.outputSchema)]).toEqual(["lookup", true, true])
  expect<ReadonlyArray<unknown>>([listed?.inputSchema, listed?.outputSchema]).toEqual([toolParametersSchema(Lookup), strictJsonSchema(Lookup.successSchema)])
})
test("a tool's handler may read only the services it declares, and gets them where it runs, once each is there", async () => {
  const Where = Tool.make("where", { parameters: Schema.Struct({}), success: Schema.String })
  const Prefix = Context.Reference<string>("test/Prefix", { defaultValue: () => "in" })
  const workspace = SessionEnvironment.pipe(Effect.map((environment) => environment.workspace))
  const declared = defineTool({ tool: Where, requires: [SessionEnvironment, Prefix], handler: () => Effect.all([Prefix, workspace], { concurrency: 1 }).pipe(Effect.map((parts) => parts.join(" "))) })
  // @ts-expect-error -- the handler reads SessionEnvironment, which `requires` does not list.
  const undeclared = defineTool({ tool: Where, handler: () => workspace })
  // A Reference has a default, so a registry has nothing to check for it.
  expect([declared.requires, undeclared.requires]).toEqual([[SessionEnvironment.key], []])
  const at = (name: string) => Effect.runPromise(Effect.provideService(declared.handler({}), SessionEnvironment, { workspace: name }))
  expect([await at("a"), await at("b")]).toEqual(["in a", "in b"])
  expect(await Effect.runPromise(Effect.flip(declared.handler({})))).toMatchObject({ code: "requires.missing", message: `where requires ${SessionEnvironment.key}` })
})
