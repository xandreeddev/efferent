import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { ModelCatalog, modelCatalogConformance } from "@xandreed/core"
import { MemoryAuthStoreLive } from "../auth/memory-auth.adapter.js"
import { configuredModelCatalog, ConfiguredModelCatalogLive, reasoningEffortsFor } from "./modelCatalog.js"

describe("ConfiguredModelCatalogLive conforms to the ModelCatalog contract", () => {
  const catalog = Effect.runSync(Effect.service(ModelCatalog).pipe(Effect.provide(ConfiguredModelCatalogLive), Effect.provide(MemoryAuthStoreLive(new Map([
    ["opencode", { type: "api_key", key: "secret" }],
    ["openai-codex", { type: "oauth", access: "a", refresh: "r", expires: 1 }],
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
      ["opencode", { type: "api_key" as const, key: "secret" }],
      ["openai-codex", { type: "oauth" as const, access: "a", refresh: "r", expires: 1 }],
    ]))
    expect(entries.some((entry) => entry.selection === "opencode:glm-5.2")).toBe(true)
    expect(entries.some((entry) => entry.selection === "openai-codex:gpt-5.5")).toBe(true)
    expect(entries.some((entry) => entry.selection === "openai-codex:gpt-5.6-luna")).toBe(true)
    expect(entries.some((entry) => entry.provider === "anthropic")).toBe(false)
  })

  it("contains only the enabled OpenCode Go inventory supplied by the user", () => {
    const entries = configuredModelCatalog(new Map([["opencode", { type: "api_key" as const, key: "secret" }]]))
    expect(entries.some((entry) => entry.selection === "opencode:glm-5.2")).toBe(true)
    expect(entries.some((entry) => entry.selection === "opencode:qwen3.7-max")).toBe(true)
    expect(entries.some((entry) => entry.selection === "opencode:grok-4.5")).toBe(false)
  })

  it("keeps subscription and API-key routes distinct and model effort dependent", () => {
    const entries = configuredModelCatalog(new Map([
      ["openai", { type: "api_key" as const, key: "secret" }],
      ["openai-codex", { type: "oauth" as const, access: "a", refresh: "r", expires: 1 }],
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
