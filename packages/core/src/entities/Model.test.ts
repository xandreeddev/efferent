import { describe, expect, it } from "bun:test"
import {
  contextWindowFor,
  defaultModelForProvider,
  defaultModelForProviders,
  parseModel,
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
  it("still infers openai / google", () => {
    expect(parseModel("gpt-4o").provider).toBe("openai")
    expect(parseModel("gemini-3.5-flash").provider).toBe("google")
  })
})

describe("contextWindowFor — anthropic", () => {
  it("defaults to 200k", () => {
    expect(contextWindowFor("anthropic", "claude-sonnet-4-5")).toBe(200_000)
  })
  it("recognises a 1M beta window", () => {
    expect(contextWindowFor("anthropic", "claude-sonnet-4-5-1m")).toBe(1_000_000)
  })
})

describe("defaultModelForProviders", () => {
  it("single provider → that provider's default", () => {
    expect(defaultModelForProviders(["google"])).toBe("google:gemini-3.5-flash")
    expect(defaultModelForProviders(["openai"])).toBe("openai:gpt-4o")
    expect(defaultModelForProviders(["anthropic"])).toBe(defaultModelForProvider("anthropic"))
    expect(defaultModelForProviders(["anthropic"]).startsWith("anthropic:claude")).toBe(true)
  })
  it("priority anthropic → google → openai when several are present", () => {
    expect(defaultModelForProviders(["openai", "google", "anthropic"]).startsWith("anthropic:")).toBe(true)
    expect(defaultModelForProviders(["openai", "google"])).toBe("google:gemini-3.5-flash")
  })
  it("empty → the ultimate default", () => {
    expect(defaultModelForProviders([])).toBe("google:gemini-3.5-flash")
  })
})
