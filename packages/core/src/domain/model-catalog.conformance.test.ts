import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import type { ModelCatalogEntry } from "./model-catalog.entity.js"
import { ModelCatalog } from "../ports/model-catalog.port.js"
import { modelCatalogConformance } from "./model-catalog.conformance.js"

const entries: ReadonlyArray<ModelCatalogEntry> = [
  { selection: "opencode:glm-5.1", provider: "opencode", credential: "api_key", limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 } },
  { selection: "local:llama3.1:8b", label: "Local · llama3.1:8b", provider: "local", credential: "local" },
  { selection: "openai-codex:gpt-5.5", provider: "openai-codex", credential: "oauth" },
]
const catalogOf = (list: ReadonlyArray<ModelCatalogEntry>) => ModelCatalog.of({ list: Effect.succeed(list) })

const failedChecks = (catalog: typeof ModelCatalog.Service, includes: ReadonlyArray<string> = []) =>
  Effect.runPromise(Effect.forEach(modelCatalogConformance(catalog, { includes }), (check) =>
    Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : []))).pipe(Effect.map((failed) => failed.flat().toSorted())))

describe("the ModelCatalog kit", () => {
  modelCatalogConformance(catalogOf(entries), { includes: ["local:llama3.1:8b"] }).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))

  test("an empty catalog conforms when nothing is expected of it", async () => {
    expect(await failedChecks(catalogOf([]))).toEqual([])
  })
})

describe("the ModelCatalog kit catches catalogs that break the contract", () => {
  test("a selection listed twice fails the unique check", async () => {
    expect(await failedChecks(catalogOf([...entries, entries[0]!]))).toEqual(["unique"])
  })

  test("a selection of another provider, or no selection at all, fails the selection check", async () => {
    expect(await failedChecks(catalogOf([...entries, { selection: "anthropic:claude-sonnet-5", provider: "opencode", credential: "api_key" }]))).toEqual(["selection"])
    expect(await failedChecks(catalogOf([...entries, { selection: "no-provider", provider: "opencode", credential: "api_key" }]))).toEqual(["selection"])
  })

  test("an entry that is not a ModelCatalogEntry fails the decode check", async () => {
    const bad = { selection: "opencode:kimi-k2.6", provider: "opencode", credential: "password" }
    expect(await failedChecks(catalogOf([...entries, bad as never]))).toEqual(["decode"])
  })

  test("unknown limits stay absent and output-only limits remain valid", async () => {
    expect(await failedChecks(catalogOf([...entries, { selection: "gateway:deployment", provider: "gateway", credential: "api_key", limits: { maxOutputTokens: 4096 } }]))).toEqual([])
  })

  test("a careless catalog's invalid limit fails decode rather than advertising an unusable token bound", async () => {
    const invalid = [0, -1, 1.5, Infinity, NaN]
    const failures = await Promise.all(invalid.flatMap((value) => ["contextWindow", "maxOutputTokens"].map((key) =>
      failedChecks(catalogOf([...entries, { selection: "gateway:deployment", provider: "gateway", credential: "api_key", limits: { [key]: value } } as never])),
    )))
    expect(failures).toEqual(invalid.flatMap(() => [["decode"], ["decode"]]))
  })

  test("a catalog that changes between two lists fails the stable check", async () => {
    const calls = Effect.runSync(Ref.make(0))
    const shifting = ModelCatalog.of({ list: Ref.getAndUpdate(calls, (n) => n + 1).pipe(Effect.map((n) => n % 2 === 0 ? entries : entries.toReversed())) })
    expect(await failedChecks(shifting)).toEqual(["stable"])
  })

  test("a model the host expects but the catalog lacks fails the includes check", async () => {
    expect(await failedChecks(catalogOf(entries), ["google:gemini-3.5-flash"])).toEqual(["includes"])
  })
})
