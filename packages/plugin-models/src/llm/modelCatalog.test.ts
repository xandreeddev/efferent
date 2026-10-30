import { describe, expect, it } from "bun:test"
import { Effect, Redacted } from "effect"
import { ModelCatalog } from "@xandreed/core"
import { modelCatalogConformance } from "@xandreed/core/conformance"
import type { ModelCatalogEntryType } from "@xandreed/core"
import type { Credential } from "../ports/auth-store.port.js"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import { MemoryAuthStoreLive } from "../auth/memory-auth.adapter.js"
import { configuredModelCatalog, ConfiguredModelCatalogLive, imageInputFor, reasoningEffortsFor } from "./modelCatalog.js"

describe("ConfiguredModelCatalogLive conforms to the ModelCatalog contract", () => {
  const catalog = Effect.runSync(Effect.service(ModelCatalog).pipe(Effect.provide(ConfiguredModelCatalogLive), Effect.provide(MemoryAuthStoreLive(new Map([
    ["opencode", { type: "api_key", key: Redacted.make("secret") }],
    ["openai-codex", { type: "oauth", access: Redacted.make("a"), refresh: Redacted.make("r"), expires: 1 }],
    ["local", { type: "local", baseUrl: "http://127.0.0.1:1/v1" }],
  ])))))
  modelCatalogConformance(catalog, { includes: ["opencode:glm-5.2", "openai-codex:gpt-5.5"] }).map((check) => it(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

describe("configured model catalog", () => {
  it("exposes only providers with configured credentials", () => {
    const entries = configuredModelCatalog(new Map([
      ["opencode", { type: "api_key" as const, key: Redacted.make("secret") }],
      ["openai-codex", { type: "oauth" as const, access: Redacted.make("a"), refresh: Redacted.make("r"), expires: 1 }],
    ]))
    expect(entries.some((entry) => entry.selection === "opencode:glm-5.2")).toBe(true)
    expect(entries.some((entry) => entry.selection === "openai-codex:gpt-5.5")).toBe(true)
    expect(entries.some((entry) => entry.selection === "openai-codex:gpt-5.6-luna")).toBe(true)
    expect(entries.some((entry) => entry.provider === "anthropic")).toBe(false)
  })

  it("contains only the enabled OpenCode Go inventory supplied by the user", () => {
    const entries = configuredModelCatalog(new Map([["opencode", { type: "api_key" as const, key: Redacted.make("secret") }]]))
    expect(entries.some((entry) => entry.selection === "opencode:glm-5.2")).toBe(true)
    expect(entries.some((entry) => entry.selection === "opencode:qwen3.7-max")).toBe(true)
    expect(entries.some((entry) => entry.selection === "opencode:grok-4.5")).toBe(false)
  })

  it("keeps subscription and API-key routes distinct and model effort dependent", () => {
    const entries = configuredModelCatalog(new Map([
      ["openai", { type: "api_key" as const, key: Redacted.make("secret") }],
      ["openai-codex", { type: "oauth" as const, access: Redacted.make("a"), refresh: Redacted.make("r"), expires: 1 }],
    ]))
    expect(entries.find((entry) => entry.selection === "openai:gpt-5.6-luna")?.label)
      .toBe("OpenAI API key · gpt-5.6-luna")
    expect(entries.find((entry) => entry.selection === "openai-codex:gpt-5.6-luna")?.label)
      .toBe("OpenAI subscription · gpt-5.6-luna")
    expect(reasoningEffortsFor("openai:gpt-5.6-luna")).toEqual(["low", "medium", "high"])
    expect(reasoningEffortsFor("openai-codex:gpt-5.6-luna")).toEqual([
      "none", "low", "medium", "high", "xhigh", "max",
    ])
    expect(reasoningEffortsFor("opencode:glm-5.2")).toEqual([])
  })
})

describe("image input per route", () => {
  it("Anthropic, the OpenAI Responses routes and Gemini read images; OpenCode's chat models, Spark and unknown providers do not", () => {
    expect(["anthropic:claude-sonnet-5", "openai:gpt-5.5", "openai-codex:gpt-5.6-luna", "opencode:gpt-5.6-luna", "google:gemini-3.5-flash"].map(imageInputFor)).toEqual([true, true, true, true, true])
    expect(["opencode:glm-5.2", "opencode:kimi-k2.7-code", "openai-codex:gpt-5.3-codex-spark", "local:llama3.1:8b", "nonsense"].map(imageInputFor)).toEqual([false, false, false, false, false])
  })

  it("the catalog states each model's input", () => {
    const entries = configuredModelCatalog(new Map([["opencode", { type: "api_key" as const, key: Redacted.make("secret") }], ["anthropic", { type: "api_key" as const, key: Redacted.make("secret") }]]))
    expect(entries.find((entry) => entry.selection === "opencode:glm-5.2")?.input).toEqual(["text"])
    expect(entries.find((entry) => entry.selection === "anthropic:claude-sonnet-5")?.input).toEqual(["text", "image"])
  })

  it("input follows the route a model is sent through: a configured endpoint of the provider's name by its images, a local credential's URL text only", () => {
    const credentials = new Map<string, Credential>([["anthropic", { type: "api_key", key: Redacted.make("secret") }], ["openai", { type: "local", baseUrl: "http://127.0.0.1:1/v1" }]])
    const inputOf = (entries: ReadonlyArray<ModelCatalogEntryType>, selection: string) => entries.find((entry) => entry.selection === selection)?.input
    const overridden = configuredModelCatalog(credentials, { anthropic: { url: "http://127.0.0.1:2/v1" } })
    expect([inputOf(overridden, "anthropic:claude-sonnet-5"), inputOf(overridden, "openai:gpt-5.5")]).toEqual([["text"], ["text"]])
    const reading = configuredModelCatalog(credentials, { anthropic: { url: "http://127.0.0.1:2/v1", images: true } })
    expect(inputOf(reading, "anthropic:claude-sonnet-5")).toEqual(["text", "image"])
    const live = Effect.runSync(Effect.service(ModelCatalog).pipe(
      Effect.flatMap((catalog) => catalog.list),
      Effect.provide(ConfiguredModelCatalogLive),
      Effect.provide(MemoryAuthStoreLive(credentials)),
      Effect.provideService(CurrentModelEndpoints, { anthropic: { url: "http://127.0.0.1:2/v1" } }),
    ))
    expect(inputOf(live, "anthropic:claude-sonnet-5")).toEqual(["text"])
  })
})
