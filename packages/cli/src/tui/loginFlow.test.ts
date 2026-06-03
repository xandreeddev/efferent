import { describe, expect, it } from "bun:test"
import { selectedValue } from "./selectBox.js"
import {
  loginAdvance,
  loginAppend,
  loginBack,
  loginMove,
  openLogin,
  type LoginFlow,
  type ProviderStatus,
} from "./loginFlow.js"

const STATUSES: ReadonlyArray<ProviderStatus> = [
  { provider: "anthropic", configured: "api_key" },
  { provider: "google", configured: undefined },
  { provider: "openai", configured: undefined },
]

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

describe("loginFlow", () => {
  it("opens at the auth-method step with two options", () => {
    const flow = openLogin(STATUSES)
    expect(flow.step).toBe("authMethod")
    if (flow.step === "authMethod") {
      expect(flow.sel.all.map((o) => o.value)).toEqual(["subscription", "api_key"])
    }
  })

  it("api-key path: authMethod → provider → apiKey, then commits the key", () => {
    let flow = openLogin(STATUSES)
    // pick "Use an API key" (second option)
    flow = loginMove(flow, "down")
    let adv = loginAdvance(flow)
    expect(adv.kind).toBe("flow")
    if (adv.kind !== "flow") throw new Error("expected flow")
    flow = adv.flow
    expect(flow.step).toBe("provider")
    if (flow.step === "provider") expect(flow.method).toBe("api_key")

    // pick the first provider (anthropic) → apiKey step
    adv = loginAdvance(flow)
    expect(adv.kind).toBe("flow")
    if (adv.kind !== "flow") throw new Error("expected flow")
    flow = adv.flow
    expect(flow.step).toBe("apiKey")
    if (flow.step === "apiKey") expect(flow.provider).toBe("anthropic")

    // type a key + advance → apiKey commit outcome
    for (const ch of "sk-xyz") flow = loginAppend(flow, ch)
    const commit = loginAdvance(flow)
    expect(commit.kind).toBe("apiKey")
    if (commit.kind === "apiKey") {
      expect(commit.provider).toBe("anthropic")
      expect(commit.key).toBe("sk-xyz")
    }
  })

  it("subscription path lists only providers with OAuth and starts OAuth", () => {
    let flow = openLogin(STATUSES) // "subscription" is selected first
    let adv = loginAdvance(flow)
    if (adv.kind !== "flow") throw new Error("expected flow")
    flow = adv.flow
    expect(flow.step).toBe("provider")
    if (flow.step === "provider") {
      expect(flow.method).toBe("subscription")
      expect(flow.sel.all.map((o) => o.value)).toEqual(["anthropic", "openai"])
    }
    adv = loginAdvance(flow)
    expect(adv.kind).toBe("startOAuth")
    if (adv.kind === "startOAuth") expect(adv.provider).toBe("anthropic")
  })

  it("Esc steps back: provider → authMethod, authMethod → undefined", () => {
    let flow = openLogin(STATUSES)
    const adv = loginAdvance(flow) // → provider (subscription)
    if (adv.kind !== "flow") throw new Error("expected flow")
    flow = adv.flow
    const back = loginBack(flow)
    expect(back?.step).toBe("authMethod")
    expect(loginBack(openLogin(STATUSES))).toBeUndefined()
  })

  it("tags configured providers in the api-key provider list", () => {
    let flow = openLogin(STATUSES)
    flow = loginMove(flow, "down") // api_key
    const adv = loginAdvance(flow)
    if (adv.kind !== "flow" || adv.flow.step !== "provider") {
      throw new Error("expected provider step")
    }
    const labels = adv.flow.sel.all.map((o) => stripAnsi(o.label))
    expect(labels.find((l) => l.startsWith("Anthropic"))).toContain("✓ api key")
    expect(labels.find((l) => l.startsWith("Google"))).toContain("• unconfigured")
  })
})
