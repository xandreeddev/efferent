import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import {
  loginAdvance,
  loginAppend,
  loginBack,
  loginMove,
  loginSetOAuthStatus,
  oauthStep,
  openLogin,
} from "./loginFlow.js"
import type { ProviderStatus } from "./loginFlow.js"

const statuses: ReadonlyArray<ProviderStatus> = [
  { provider: "anthropic", configured: Option.some("oauth") },
  { provider: "openai", configured: Option.none() },
  { provider: "google", configured: Option.none() },
  { provider: "opencode", configured: Option.some("api_key") },
]

describe("loginFlow — the pure provider manager", () => {
  test("home lists every provider with its status tag; configured rows active", () => {
    const flow = openLogin(statuses)
    expect(flow.step).toBe("home")
    if (flow.step !== "home") return
    const rows = flow.sel.all
    expect(rows.map((r) => r.label)).toEqual(["Anthropic", "OpenAI", "Google", "OpenCode", "✓ Done"])
    expect(rows[0]?.tag).toBe("subscription")
    expect(rows[3]?.tag).toBe("api key")
    expect(rows[1]?.tag).toBeUndefined()
  })

  test("anthropic goes to the METHOD step; others go straight to apiKey", () => {
    const home = openLogin(statuses)
    const anth = loginAdvance(home)
    expect(anth.kind === "flow" && anth.flow.step === "method").toBe(true)

    const onOpenai = loginMove(home, "down")
    const adv = loginAdvance(onOpenai)
    expect(adv.kind === "flow" && adv.flow.step === "apiKey").toBe(true)
    if (adv.kind !== "flow" || adv.flow.step !== "apiKey") return
    expect(adv.flow.provider).toBe("openai")
  })

  test("the method step: api_key → prompt; subscription → startOAuth", () => {
    const method = loginAdvance(openLogin(statuses))
    expect(method.kind).toBe("flow")
    if (method.kind !== "flow") return
    expect(loginAdvance(method.flow)).toEqual({ kind: "startOAuth", provider: "anthropic" })
    const onApiKey = loginMove(method.flow, "down")
    const adv = loginAdvance(onApiKey)
    expect(adv.kind === "flow" && adv.flow.step === "apiKey").toBe(true)
  })

  test("a typed key advances as apiKey; empty input is none", () => {
    const home = openLogin(statuses)
    const toKey = loginAdvance(loginMove(home, "down"))
    expect(toKey.kind).toBe("flow")
    if (toKey.kind !== "flow") return
    expect(loginAdvance(toKey.flow)).toEqual({ kind: "none" })
    const typed = [..."sk-test"].reduce((f, ch) => loginAppend(f, ch), toKey.flow)
    expect(loginAdvance(typed)).toEqual({ kind: "apiKey", provider: "openai", key: "sk-test" })
  })

  test("the masked prompt never exposes the key in its display state", () => {
    const toKey = loginAdvance(loginMove(openLogin(statuses), "down"))
    expect(toKey.kind === "flow" && toKey.flow.step === "apiKey").toBe(true)
    if (toKey.kind !== "flow" || toKey.flow.step !== "apiKey") return
    expect(toKey.flow.prompt.mask).toBe(true)
  })

  test("back-navigation: oauth → method → home → None (close)", () => {
    const oauth = oauthStep(statuses, "anthropic", "https://claude.ai/oauth/x")
    const method = Option.getOrThrow(loginBack(oauth))
    expect(method.step).toBe("method")
    const home = Option.getOrThrow(loginBack(method))
    expect(home.step).toBe("home")
    expect(Option.isNone(loginBack(home))).toBe(true)
  })

  test("a pasted redirect advances as oauthManual; the status line updates", () => {
    const oauth = oauthStep(statuses, "anthropic", "https://claude.ai/oauth/x")
    const pasted = [..."http://localhost:53692/callback?code=c#v"].reduce(
      (f, ch) => loginAppend(f, ch),
      oauth,
    )
    const adv = loginAdvance(pasted)
    expect(adv.kind).toBe("oauthManual")
    if (adv.kind !== "oauthManual") return
    expect(adv.provider).toBe("anthropic")
    const updated = loginSetOAuthStatus(oauth, "Waiting for the browser…")
    expect(updated.step).toBe("oauth")
    if (updated.step !== "oauth") return
    expect(updated.status).toBe("Waiting for the browser…")
  })

  test("Done finishes", () => {
    const home = openLogin(statuses)
    const onDone = [0, 1, 2, 3].reduce((f) => loginMove(f, "down"), home)
    expect(loginAdvance(onDone)).toEqual({ kind: "done" })
  })
})
