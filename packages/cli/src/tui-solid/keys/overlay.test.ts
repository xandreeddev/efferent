import { test, expect } from "bun:test"
import type { ConversationId } from "@efferent/core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { openSelect, type SelectState } from "../presentation/selectBox.js"
import { openLogin, type LoginFlow, type ProviderStatus } from "../presentation/loginFlow.js"
import { openSettings, type SettingsRow, type SettingsState } from "../presentation/settingsView.js"
import { createTuiStore, type TuiContext, type TuiStore } from "../state/store.js"
import { overlayKey } from "./overlay.js"
import type { Key } from "./ParsedKey.js"

const cid = "00000000-0000-0000-0000-000000000000" as unknown as ConversationId

const newStore = (): TuiStore =>
  createTuiStore({
    status: {
      modelId: "m",
      contextWindow: 1000,
      inputTokens: 0,
      cacheReadTokens: 0,
      cwd: "/work",
      storage: "sqlite",
    },
    conversationId: cid,
    footer: "f",
    sidePane: { ...emptySidePane, stats: { ...emptyStats, contextWindow: 1000 } },
  })

const ctxOf = (store: TuiStore): TuiContext => ({
  store,
  run: () => Promise.resolve(undefined as never),
  submit: () => {},
  interrupt: () => {},
  exit: () => {},
  copySelection: () => false,
})

const key = (name: string, mods: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  shift: false,
  meta: false,
  option: false,
  ...mods,
})

const openModelOverlay = (store: TuiStore): void =>
  store.setOverlay({
    kind: "select",
    sel: openSelect("Select a model", [
      { value: { id: "a" }, label: "google:gemini-3.5-flash", active: true },
      { value: { id: "b" }, label: "openai:gpt-5.5" },
      { value: { id: "c" }, label: "anthropic:claude" },
    ]),
    purpose: { tag: "model" },
  })

const curSel = (store: TuiStore): SelectState<unknown> => {
  const o = store.overlay()
  if (o.kind !== "select") throw new Error("expected a select overlay")
  return o.sel
}

test("overlayKey consumes keys only while an overlay is open", () => {
  const store = newStore()
  expect(overlayKey(ctxOf(store), key("j"))).toBe(false) // none open → not consumed
  openModelOverlay(store)
  expect(overlayKey(ctxOf(store), key("x"))).toBe(true) // open → swallows input
})

test("↓ moves the selection; the active option starts highlighted", () => {
  const store = newStore()
  openModelOverlay(store)
  expect(curSel(store).selected).toBe(0) // the `active` option
  overlayKey(ctxOf(store), key("down"))
  expect(curSel(store).selected).toBe(1)
  overlayKey(ctxOf(store), key("up"))
  expect(curSel(store).selected).toBe(0)
})

test("typing filters the list; Backspace restores it", () => {
  const store = newStore()
  openModelOverlay(store)
  for (const ch of "openai") overlayKey(ctxOf(store), key(ch))
  expect(curSel(store).filter).toBe("openai")
  expect(curSel(store).matches).toHaveLength(1)
  expect(curSel(store).matches[0]!.label).toContain("openai")
  overlayKey(ctxOf(store), key("backspace"))
  expect(curSel(store).filter).toBe("opena")
})

test("Esc closes the overlay; Ctrl-C closes it too (not quit)", () => {
  const store = newStore()
  openModelOverlay(store)
  overlayKey(ctxOf(store), key("escape"))
  expect(store.overlay().kind).toBe("none")

  openModelOverlay(store)
  overlayKey(ctxOf(store), key("c", { ctrl: true }))
  expect(store.overlay().kind).toBe("none")
})

test("Enter closes the overlay (submit dispatched via ctx.run)", () => {
  const store = newStore()
  openModelOverlay(store)
  overlayKey(ctxOf(store), key("return"))
  expect(store.overlay().kind).toBe("none")
})

// --- login flow ---

const STATUSES: ReadonlyArray<ProviderStatus> = [
  { provider: "anthropic", configured: "oauth" },
  { provider: "google", configured: "api_key" },
  { provider: "openai", configured: undefined },
  { provider: "opencode", configured: undefined },
  { provider: "ollama", configured: undefined },
]

const openLoginOverlay = (store: TuiStore): void =>
  store.setOverlay({ kind: "login", flow: openLogin(STATUSES) })

const curLogin = (store: TuiStore): LoginFlow => {
  const o = store.overlay()
  if (o.kind !== "login") throw new Error("expected a login overlay")
  return o.flow
}

test("login: ↓ moves the auth-method selection", () => {
  const store = newStore()
  openLoginOverlay(store)
  const flow = curLogin(store)
  expect(flow.step).toBe("authMethod")
  overlayKey(ctxOf(store), key("down"))
  const moved = curLogin(store)
  if (moved.step !== "authMethod") throw new Error("step changed unexpectedly")
  expect(moved.sel.selected).toBe(1) // "Use an API key"
})

test("login: typing appends to the active prompt step", () => {
  const store = newStore()
  // Jump straight to the api-key prompt step to exercise text entry.
  store.setOverlay({
    kind: "login",
    flow: {
      step: "apiKey",
      statuses: STATUSES,
      provider: "google",
      prompt: { title: "Log in to Google", prompt: "Paste your API key", value: "", mask: true },
    },
  })
  for (const ch of "sk-abc") overlayKey(ctxOf(store), key(ch))
  const flow = curLogin(store)
  if (flow.step !== "apiKey") throw new Error("expected apiKey step")
  expect(flow.prompt.value).toBe("sk-abc")
  overlayKey(ctxOf(store), key("backspace"))
  if (curLogin(store).step !== "apiKey") throw new Error("step changed")
  expect((curLogin(store) as { prompt: { value: string } }).prompt.value).toBe("sk-ab")
})

test("login: Esc steps back to the auth-method, then closes", () => {
  const store = newStore()
  openLoginOverlay(store)
  // advance to the provider step (Enter on authMethod → provider)
  overlayKey(ctxOf(store), key("return"))
  expect(curLogin(store).step).toBe("provider")
  overlayKey(ctxOf(store), key("escape")) // back to authMethod
  expect(curLogin(store).step).toBe("authMethod")
  overlayKey(ctxOf(store), key("escape")) // closes
  expect(store.overlay().kind).toBe("none")
})

// --- settings table ---

const SETTINGS_ROWS: ReadonlyArray<SettingsRow> = [
  { key: "allowBash", label: "allowBash", value: "true", kind: "boolean" },
  { key: "maxSteps", label: "maxSteps", value: "20", kind: "number" },
  { key: "model", label: "model", value: "ollama:x", kind: "readonly", hint: "use :model" },
]

const openSettingsOverlay = (store: TuiStore): void =>
  store.setOverlay({ kind: "settings", state: openSettings(SETTINGS_ROWS) })

const curSettings = (store: TuiStore): SettingsState => {
  const o = store.overlay()
  if (o.kind !== "settings") throw new Error("expected a settings overlay")
  return o.state
}

test("settings: ↓ moves the row cursor", () => {
  const store = newStore()
  openSettingsOverlay(store)
  expect(curSettings(store).cursor).toBe(0)
  overlayKey(ctxOf(store), key("down"))
  expect(curSettings(store).cursor).toBe(1)
})

test("settings: Enter on the number row opens an inline edit; typing fills the buffer", () => {
  const store = newStore()
  openSettingsOverlay(store)
  overlayKey(ctxOf(store), key("down")) // → maxSteps (number)
  overlayKey(ctxOf(store), key("return")) // begin edit
  expect(curSettings(store).editBuffer).toBe("20") // seeded with the value
  overlayKey(ctxOf(store), key("backspace"))
  overlayKey(ctxOf(store), key("backspace"))
  overlayKey(ctxOf(store), key("5"))
  expect(curSettings(store).editBuffer).toBe("5")
  // Esc cancels the edit but keeps the modal open.
  overlayKey(ctxOf(store), key("escape"))
  expect(store.overlay().kind).toBe("settings")
  expect(curSettings(store).editBuffer).toBeUndefined()
})

test("settings: Esc with no edit closes the modal", () => {
  const store = newStore()
  openSettingsOverlay(store)
  overlayKey(ctxOf(store), key("escape"))
  expect(store.overlay().kind).toBe("none")
})
