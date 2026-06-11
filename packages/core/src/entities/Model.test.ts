import { describe, expect, it } from "bun:test"
import {
  contextWindowFor,
  defaultModelForProvider,
  defaultModelForProviders,
  parseModel,
  modelForRole,
  roleIsConfigured,
  selectionFromString,
} from "./Model.js"

describe("parseModel — anthropic", () => {
  it("honours an explicit anthropic: prefix", () => {
    expect(parseModel("anthropic:claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    })
  })
  it("infers anthropic from a claude-shaped id", () => {
    expect(parseModel("claude-3-5-haiku-latest")).toEqual({
      provider: "anthropic",
      modelId: "claude-3-5-haiku-latest",
    })
  })
  it("still infers openai / google / opencode", () => {
    expect(parseModel("gpt-4o").provider).toBe("openai")
    expect(parseModel("gemini-3.5-flash").provider).toBe("google")
    expect(parseModel("deepseek-v4-pro").provider).toBe("opencode")
    expect(parseModel("kimi-k2.5").provider).toBe("opencode")
  })
})

describe("contextWindowFor — anthropic", () => {
  it("reads the real 1M window from the catalogue (not the 200k heuristic)", () => {
    expect(contextWindowFor("anthropic", "claude-opus-4-8")).toBe(1_000_000)
    expect(contextWindowFor("anthropic", "claude-sonnet-4-6")).toBe(1_000_000)
  })
  it("reads a 200k window from the catalogue", () => {
    expect(contextWindowFor("anthropic", "claude-sonnet-4-5")).toBe(200_000)
  })
  it("strips a trailing date stamp to hit the base id", () => {
    expect(contextWindowFor("anthropic", "claude-opus-4-8-20260101")).toBe(1_000_000)
  })
  it("falls back to the heuristic for an id not in the catalogue", () => {
    // unknown future id → 200k anthropic default
    expect(contextWindowFor("anthropic", "claude-zephyr-9")).toBe(200_000)
    // the legacy 1M-beta substring still works via the heuristic fallback
    expect(contextWindowFor("anthropic", "claude-zephyr-9-1m")).toBe(1_000_000)
  })
})

describe("defaultModelForProviders", () => {
  it("single provider → that provider's default", () => {
    expect(defaultModelForProviders(["google"])).toBe("google:gemini-3.5-flash")
    expect(defaultModelForProviders(["openai"])).toBe("openai:gpt-4o")
    expect(defaultModelForProviders(["anthropic"])).toBe(defaultModelForProvider("anthropic"))
    expect(defaultModelForProviders(["anthropic"]).startsWith("anthropic:claude")).toBe(true)
    expect(defaultModelForProviders(["opencode"])).toBe("opencode:deepseek-v4-pro")
  })
  it("priority anthropic → google → openai → opencode when several are present", () => {
    expect(defaultModelForProviders(["openai", "google", "anthropic"]).startsWith("anthropic:")).toBe(true)
    expect(defaultModelForProviders(["openai", "google"])).toBe("google:gemini-3.5-flash")
    expect(defaultModelForProviders(["opencode", "openai"])).toBe("openai:gpt-4o")
  })
  it("empty → the ultimate default", () => {
    expect(defaultModelForProviders([])).toBe("google:gemini-3.5-flash")
  })
})

describe("model roles (main / fast / cheap)", () => {
  const base = { model: "google:gemini-3.5-pro" }
  it("main is always the chat selection", () => {
    expect(modelForRole(base, "main")).toBe("google:gemini-3.5-pro")
    expect(roleIsConfigured(base, "main")).toBe(true)
  })
  it("fast falls back to main; explicit wins", () => {
    expect(modelForRole(base, "fast")).toBe("google:gemini-3.5-pro")
    expect(roleIsConfigured(base, "fast")).toBe(false)
    const set = { ...base, fastModel: "google:gemini-3.5-flash" }
    expect(modelForRole(set, "fast")).toBe("google:gemini-3.5-flash")
    expect(roleIsConfigured(set, "fast")).toBe(true)
  })
  it("cheap falls back legacy utilityModel → main; cheapModel wins over the alias", () => {
    expect(modelForRole(base, "cheap")).toBe("google:gemini-3.5-pro")
    expect(roleIsConfigured(base, "cheap")).toBe(false)
    const legacy = { ...base, utilityModel: "google:gemini-3.5-flash-lite" }
    expect(modelForRole(legacy, "cheap")).toBe("google:gemini-3.5-flash-lite")
    expect(roleIsConfigured(legacy, "cheap")).toBe(true)
    const both = { ...legacy, cheapModel: "openai:gpt-5.4-nano" }
    expect(modelForRole(both, "cheap")).toBe("openai:gpt-5.4-nano")
  })
  it("selectionFromString parses + resolves the context window", () => {
    const sel = selectionFromString("openai:gpt-4o")
    expect(sel.provider).toBe("openai")
    expect(sel.modelId).toBe("gpt-4o")
    expect(sel.contextWindow).toBeGreaterThan(0)
  })
})
