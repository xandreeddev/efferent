import { describe, expect, it } from "bun:test"
import { Arbitrary, FastCheck as fc } from "effect"
import {
  catalogModelsForProvider,
  contextWindowFor,
  defaultModelForProvider,
  defaultModelForProviders,
  formatModel,
  parseModel,
  Provider,
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
    expect(contextWindowFor("anthropic", "claude-haiku-4-5")).toBe(200_000)
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

describe("catalogModelsForProvider — offline picker fallback", () => {
  it("yields complete ModelInfo rows from the bundled snapshot", () => {
    const rows = catalogModelsForProvider("anthropic")
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.provider).toBe("anthropic")
      expect(r.modelId.length).toBeGreaterThan(0)
      expect(r.displayName.length).toBeGreaterThan(0)
      expect(r.contextWindow).toBeGreaterThan(0)
    }
    // a known snapshot id with its real (catalogue) window, not the heuristic
    expect(rows.some((r) => r.modelId === "claude-opus-4-8" && r.contextWindow === 1_000_000)).toBe(true)
  })
  it("covers every first-class provider so a single outage never empties the picker", () => {
    for (const p of ["google", "openai", "anthropic", "opencode"] as const) {
      expect(catalogModelsForProvider(p).length).toBeGreaterThan(0)
    }
  })
  it("is empty for providers absent from the snapshot (ollama is local-only)", () => {
    expect(catalogModelsForProvider("ollama")).toEqual([])
  })
})

describe("model roles (general / code / fast)", () => {
  const base = { model: "google:gemini-3.5-pro" }
  it("general is always the chat selection", () => {
    expect(modelForRole(base, "general")).toBe("google:gemini-3.5-pro")
    expect(roleIsConfigured(base, "general")).toBe(true)
  })
  it("fast falls back to general; explicit wins", () => {
    expect(modelForRole(base, "fast")).toBe("google:gemini-3.5-pro")
    expect(roleIsConfigured(base, "fast")).toBe(false)
    const set = { ...base, fastModel: "google:gemini-3.5-flash" }
    expect(modelForRole(set, "fast")).toBe("google:gemini-3.5-flash")
    expect(roleIsConfigured(set, "fast")).toBe(true)
  })
  it("code falls back to general; explicit wins", () => {
    expect(modelForRole(base, "code")).toBe("google:gemini-3.5-pro")
    expect(roleIsConfigured(base, "code")).toBe(false)
    const set = { ...base, codeModel: "anthropic:claude-sonnet-4-5" }
    expect(modelForRole(set, "code")).toBe("anthropic:claude-sonnet-4-5")
    expect(roleIsConfigured(set, "code")).toBe(true)
  })
  it("selectionFromString parses + resolves the context window", () => {
    const sel = selectionFromString("openai:gpt-4o")
    expect(sel.provider).toBe("openai")
    expect(sel.modelId).toBe("gpt-4o")
    expect(sel.contextWindow).toBeGreaterThan(0)
  })
})

describe("properties — parseModel / formatModel", () => {
  it("parse∘format is the identity for any provider and any model id", () => {
    // Even ids containing ':' round-trip — parseModel splits on the FIRST colon.
    fc.assert(
      fc.property(Arbitrary.make(Provider), fc.string(), (provider, modelId) => {
        expect(parseModel(formatModel(provider, modelId))).toEqual({ provider, modelId })
      }),
      { numRuns: 200 },
    )
  })

  it("format∘parse is stable on arbitrary raw strings (inference is idempotent)", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.fullUnicodeString()), (raw) => {
        const a = parseModel(raw)
        expect(parseModel(formatModel(a.provider, a.modelId))).toEqual(a)
      }),
      { numRuns: 200 },
    )
  })
})
