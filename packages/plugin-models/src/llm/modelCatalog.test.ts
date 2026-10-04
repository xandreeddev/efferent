import { describe, expect, it } from "bun:test"
import { AuthStore, ModelCatalog } from "@xandreed/core"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { ConfiguredModelCatalogLive, configuredModelCatalog, reasoningEffortsFor } from "./modelCatalog.js"

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
    expect(entries.some((entry) => entry.provider === "vercel")).toBe(false)
  })

  it("keeps Vercel Gateway and OpenCode Go Flash routes distinct", () => {
    const entries = configuredModelCatalog(new Map([
      ["vercel", { type: "api_key" as const, key: "gateway-key" }],
      ["opencode", { type: "api_key" as const, key: "go-key" }],
    ]))
    expect(entries.find((entry) => entry.selection === "vercel:deepseek/deepseek-v4.1-flash")?.label).toBe("DeepSeek Flash V4.1 · Vercel AI Gateway")
    expect(entries.find((entry) => entry.selection === "vercel:deepseek/deepseek-v4-flash")?.label).toBe("DeepSeek Flash V4 · Vercel AI Gateway")
    expect(entries.some((entry) => entry.selection === "opencode:deepseek-v4-flash")).toBe(true)
    expect(entries.some((entry) => entry.selection === "vercel:deepseek-v4-flash")).toBe(false)
    expect(entries.some((entry) => entry.selection === "opencode:deepseek/deepseek-v4-flash")).toBe(false)
  })

  it("refreshes gateway env presence for each picker read without exposing the key", async () => {
    const auth = Layer.succeed(AuthStore, AuthStore.of({ all: Effect.succeed(new Map()), get: () => Effect.succeed(Option.none()), resolveKey: () => Effect.succeed(Option.none()), set: () => Effect.void, remove: () => Effect.void }))
    const catalog = await Effect.runPromise(ModelCatalog.pipe(Effect.provide(ConfiguredModelCatalogLive.pipe(Layer.provide(auth)))))
    const absent = ConfigProvider.fromUnknown({})
    const configured = ConfigProvider.fromUnknown({ AI_GATEWAY_API_KEY: "fixture-gateway-env-key" })
    expect(await Effect.runPromise(catalog.list.pipe(Effect.provideService(ConfigProvider.ConfigProvider, absent)))).toEqual([])
    const entries = await Effect.runPromise(catalog.list.pipe(Effect.provideService(ConfigProvider.ConfigProvider, configured)))
    expect(entries[0]?.selection).toBe("vercel:deepseek/deepseek-v4.1-flash")
    expect(JSON.stringify(entries)).not.toContain("fixture-gateway-env-key")
    expect(await Effect.runPromise(catalog.list.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ AI_GATEWAY_API_KEY: "  " }))))).toEqual([])
    expect(await Effect.runPromise(catalog.list.pipe(Effect.provideService(ConfigProvider.ConfigProvider, absent)))).toEqual([])
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
