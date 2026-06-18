import { describe, expect, it } from "bun:test"
import { selectedValue } from "./selectBox.js"
import {
  loginAdvance,
  loginAppend,
  loginBack,
  loginMove,
  openLogin,
  type LoginFlow,
  type LoginHomeItem,
  type ProviderStatus,
} from "./loginFlow.js"

const STATUSES: ReadonlyArray<ProviderStatus> = [
  { provider: "anthropic", configured: "api_key" },
  { provider: "google", configured: undefined },
  { provider: "openai", configured: undefined },
  { provider: "opencode", configured: undefined },
  { provider: "ollama", configured: undefined },
]

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

/** Move the home cursor onto a specific provider (linear scan from the top). */
const selectProvider = (flow: LoginFlow, provider: string): LoginFlow => {
  if (flow.step !== "home") throw new Error("expected home")
  let f: LoginFlow = flow
  for (let i = 0; i < flow.sel.all.length; i++) {
    if (f.step !== "home") break
    const v = selectedValue(f.sel)
    if (v?.tag === "provider" && v.provider === provider) return f
    f = loginMove(f, "down")
  }
  return f
}

describe("loginFlow", () => {
  it("opens at the provider-manager home with a row per provider + done", () => {
    const flow = openLogin(STATUSES)
    expect(flow.step).toBe("home")
    if (flow.step === "home") {
      const values = flow.sel.all.map((o) => o.value as LoginHomeItem)
      expect(values.filter((v) => v.tag === "provider").length).toBe(5)
      expect(values.at(-1)?.tag).toBe("done")
    }
  })

  it("shows the configured status as a tag (anthropic api key, google none)", () => {
    const flow = openLogin(STATUSES)
    if (flow.step !== "home") throw new Error("expected home")
    const byProvider = (p: string) =>
      flow.sel.all.find((o) => {
        const v = o.value as LoginHomeItem
        return v.tag === "provider" && v.provider === p
      })
    expect(byProvider("anthropic")?.tag).toBe("api key")
    expect(byProvider("google")?.tag).toBeUndefined()
    expect(stripAnsi(byProvider("anthropic")?.label ?? "")).toContain("Anthropic")
  })

  it("api-key-only provider: home → apiKey → commits the key", () => {
    let flow = selectProvider(openLogin(STATUSES), "google")
    let adv = loginAdvance(flow)
    expect(adv.kind).toBe("flow")
    if (adv.kind !== "flow") throw new Error("expected flow")
    flow = adv.flow
    expect(flow.step).toBe("apiKey")
    if (flow.step === "apiKey") expect(flow.provider).toBe("google")

    for (const ch of "sk-xyz") flow = loginAppend(flow, ch)
    const commit = loginAdvance(flow)
    expect(commit.kind).toBe("apiKey")
    if (commit.kind === "apiKey") {
      expect(commit.provider).toBe("google")
      expect(commit.key).toBe("sk-xyz")
    }
  })

  it("subscription-capable provider: home → method → subscription starts OAuth", () => {
    let flow = selectProvider(openLogin(STATUSES), "anthropic")
    let adv = loginAdvance(flow)
    if (adv.kind !== "flow") throw new Error("expected flow")
    flow = adv.flow
    expect(flow.step).toBe("method")
    // "subscription" is the first method row.
    adv = loginAdvance(flow)
    expect(adv.kind).toBe("startOAuth")
    if (adv.kind === "startOAuth") expect(adv.provider).toBe("anthropic")
  })

  it("method → api_key path lands on the apiKey prompt", () => {
    const flow = selectProvider(openLogin(STATUSES), "openai")
    const toMethod = loginAdvance(flow)
    if (toMethod.kind !== "flow" || toMethod.flow.step !== "method") {
      throw new Error("expected method flow")
    }
    const m = loginMove(toMethod.flow, "down") // api_key (second row)
    const adv = loginAdvance(m)
    expect(adv.kind).toBe("flow")
    if (adv.kind === "flow") expect(adv.flow.step).toBe("apiKey")
  })

  it("local provider (ollama): home → localUrl prompt", () => {
    const flow = selectProvider(openLogin(STATUSES), "ollama")
    const adv = loginAdvance(flow)
    expect(adv.kind).toBe("flow")
    if (adv.kind === "flow") expect(adv.flow.step).toBe("localUrl")
  })

  it("done row → a `done` outcome", () => {
    let flow = openLogin(STATUSES)
    if (flow.step !== "home") throw new Error("expected home")
    // walk to the done row (last)
    while (flow.step === "home" && selectedValue(flow.sel)?.tag !== "done") {
      flow = loginMove(flow, "down")
    }
    expect(loginAdvance(flow).kind).toBe("done")
  })

  it("Esc steps back: method → home, home → undefined", () => {
    const flow = selectProvider(openLogin(STATUSES), "anthropic")
    const adv = loginAdvance(flow) // → method
    if (adv.kind !== "flow") throw new Error("expected flow")
    const back = loginBack(adv.flow)
    expect(back?.step).toBe("home")
    expect(loginBack(openLogin(STATUSES))).toBeUndefined()
  })
})
