/**
 * The in-app `:login` flow as a **pure** state machine, shaped as a **provider
 * manager** (uniform with the database manager): the home screen lists every
 * provider with its configured status, so what's already set up is always
 * visible and you can configure as many as you want. Pick a provider → choose a
 * method (subscription/API key, only where both apply) → paste a key or run the
 * OAuth flow → land back on the home list (now showing the new status). A `done`
 * row finishes. It composes `selectBox` (menu steps) and `promptBox` (text-entry
 * steps); transitions are pure and the driver performs the effects (persist a
 * key, start OAuth, refresh the home list) on the `LoginAdvance` outcome.
 */

import { type Provider } from "@xandreed/sdk-core"
import {
  filterAppend,
  filterBackspace,
  moveSelect,
  openSelect,
  type SelectOption,
  type SelectState,
  selectedValue,
} from "./selectBox.js"
import {
  openPrompt,
  promptAppend,
  promptBackspace,
  type PromptState,
} from "./promptBox.js"
import { glyph } from "./theme/glyphs.js"

export type AuthMethod = "subscription" | "api_key"

/** What's already configured for a provider (drives the status tag). */
export interface ProviderStatus {
  readonly provider: Provider
  readonly configured: "api_key" | "oauth" | "local" | undefined
}

/** A row in the login home manager: configure a provider, or finish. */
export type LoginHomeItem =
  | { readonly tag: "provider"; readonly provider: Provider }
  | { readonly tag: "done" }

export type LoginFlow =
  | {
      readonly step: "home"
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly sel: SelectState<LoginHomeItem>
    }
  | {
      readonly step: "method"
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly provider: Provider
      readonly sel: SelectState<AuthMethod>
    }
  | {
      readonly step: "apiKey"
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly provider: Provider
      readonly prompt: PromptState
    }
  | {
      readonly step: "oauth"
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly provider: Provider
      readonly status: string
      readonly manual: PromptState
    }
  | {
      readonly step: "localUrl"
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly provider: Provider
      readonly prompt: PromptState
    }

/** What the driver must do after an Enter (the pure machine can't run effects). */
export type LoginAdvance =
  | { readonly kind: "flow"; readonly flow: LoginFlow }
  | { readonly kind: "apiKey"; readonly provider: Provider; readonly key: string }
  | { readonly kind: "startOAuth"; readonly provider: Provider; readonly flow: LoginFlow }
  | { readonly kind: "oauthManual"; readonly provider: Provider; readonly redirect: string }
  | { readonly kind: "localUrl"; readonly provider: Provider; readonly baseUrl: string }
  | { readonly kind: "done" }
  | { readonly kind: "none" }

const PROVIDER_LABEL: Record<Provider, string> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  opencode: "OpenCode",
  ollama: "Ollama (local)",
}

/** The provider list shown on the home manager, in display order. */
const HOME_PROVIDERS: ReadonlyArray<Provider> = [
  "anthropic",
  "openai",
  "google",
  "opencode",
  "ollama",
]

// Anthropic and OpenAI expose subscription/OAuth flows; every provider accepts
// an API key. Ollama is local-only and uses a URL prompt instead of a key.
const SUBSCRIPTION_PROVIDERS: ReadonlyArray<Provider> = ["anthropic", "openai"]
const LOCAL_PROVIDERS: ReadonlyArray<Provider> = ["ollama"]

/** The trailing status tag for a configured provider (none when unconfigured —
 *  an empty row reads as "not set up yet"). */
const statusWord = (s: ProviderStatus["configured"]): string | undefined =>
  s === "api_key" ? "api key" : s === "oauth" ? "subscription" : s === "local" ? "local" : undefined

/** The home manager: every provider with its status, then a `done` row. Rebuilt
 *  after each login so the status tags reflect what's now configured. */
export const homeStep = (statuses: ReadonlyArray<ProviderStatus>): LoginFlow => {
  const options: ReadonlyArray<SelectOption<LoginHomeItem>> = [
    ...HOME_PROVIDERS.map((p) => {
      const configured = statuses.find((s) => s.provider === p)?.configured
      return {
        value: { tag: "provider", provider: p } as LoginHomeItem,
        label: PROVIDER_LABEL[p],
        section: "providers",
        active: configured !== undefined,
        tag: statusWord(configured),
      }
    }),
    { value: { tag: "done" } as LoginHomeItem, label: `${glyph.ok} Done`, section: "" },
  ]
  return { step: "home", statuses, sel: openSelect("Sign in to your providers", options) }
}

/** The per-provider method choice (only for providers offering both). */
const methodStep = (
  statuses: ReadonlyArray<ProviderStatus>,
  provider: Provider,
): LoginFlow => ({
  step: "method",
  statuses,
  provider,
  sel: openSelect(`Log in to ${PROVIDER_LABEL[provider]}`, [
    { value: "subscription", label: "Use a subscription (OAuth — Claude Pro/Max or ChatGPT)" },
    { value: "api_key", label: "Use an API key" },
  ]),
})

const apiKeyStep = (
  statuses: ReadonlyArray<ProviderStatus>,
  provider: Provider,
): LoginFlow => ({
  step: "apiKey",
  statuses,
  provider,
  prompt: openPrompt(`Log in to ${PROVIDER_LABEL[provider]}`, "Paste your API key", true),
})

const localUrlStep = (
  statuses: ReadonlyArray<ProviderStatus>,
  provider: Provider,
): LoginFlow => ({
  step: "localUrl",
  statuses,
  provider,
  prompt: openPrompt(
    `Connect to ${PROVIDER_LABEL[provider]}`,
    "Base URL",
    false,
    "http://localhost:11434",
  ),
})

export const oauthStep = (
  statuses: ReadonlyArray<ProviderStatus>,
  provider: Provider,
  status = "Opening your browser…",
): LoginFlow => ({
  step: "oauth",
  statuses,
  provider,
  status,
  manual: openPrompt(
    `Log in to ${PROVIDER_LABEL[provider]}`,
    "or paste the redirect URL here",
    false,
  ),
})

/** Open the login manager, tagging which providers are already configured. */
export const openLogin = (statuses: ReadonlyArray<ProviderStatus>): LoginFlow =>
  homeStep(statuses)

// NB: `home` and `method` get separate case bodies (not a fallthrough) so each
// `flow.sel` stays concretely typed — a shared body widens the union.
export const loginMove = (flow: LoginFlow, dir: "up" | "down"): LoginFlow => {
  switch (flow.step) {
    case "home":
      return { ...flow, sel: moveSelect(flow.sel, dir) }
    case "method":
      return { ...flow, sel: moveSelect(flow.sel, dir) }
    default:
      return flow
  }
}

export const loginAppend = (flow: LoginFlow, ch: string): LoginFlow => {
  switch (flow.step) {
    case "home":
      return { ...flow, sel: filterAppend(flow.sel, ch) }
    case "method":
      return { ...flow, sel: filterAppend(flow.sel, ch) }
    case "apiKey":
      return { ...flow, prompt: promptAppend(flow.prompt, ch) }
    case "oauth":
      return { ...flow, manual: promptAppend(flow.manual, ch) }
    case "localUrl":
      return { ...flow, prompt: promptAppend(flow.prompt, ch) }
  }
}

export const loginBackspace = (flow: LoginFlow): LoginFlow => {
  switch (flow.step) {
    case "home":
      return { ...flow, sel: filterBackspace(flow.sel) }
    case "method":
      return { ...flow, sel: filterBackspace(flow.sel) }
    case "apiKey":
      return { ...flow, prompt: promptBackspace(flow.prompt) }
    case "oauth":
      return { ...flow, manual: promptBackspace(flow.manual) }
    case "localUrl":
      return { ...flow, prompt: promptBackspace(flow.prompt) }
  }
}

/** Esc: step back one level, or `undefined` to close the flow entirely. */
export const loginBack = (flow: LoginFlow): LoginFlow | undefined => {
  switch (flow.step) {
    case "home":
      return undefined
    case "method":
      return homeStep(flow.statuses)
    case "apiKey":
      // Came via the method choice only for subscription-capable providers;
      // others were reached straight from the home list.
      return SUBSCRIPTION_PROVIDERS.includes(flow.provider)
        ? methodStep(flow.statuses, flow.provider)
        : homeStep(flow.statuses)
    case "oauth":
      return methodStep(flow.statuses, flow.provider)
    case "localUrl":
      return homeStep(flow.statuses)
  }
}

/** Update the OAuth step's status line (driver progress feedback). */
export const loginSetOAuthStatus = (flow: LoginFlow, status: string): LoginFlow =>
  flow.step === "oauth" ? { ...flow, status } : flow

export const loginAdvance = (flow: LoginFlow): LoginAdvance => {
  switch (flow.step) {
    case "home": {
      const item = selectedValue(flow.sel)
      if (item === undefined) return { kind: "none" }
      if (item.tag === "done") return { kind: "done" }
      const p = item.provider
      if (LOCAL_PROVIDERS.includes(p)) {
        return { kind: "flow", flow: localUrlStep(flow.statuses, p) }
      }
      return SUBSCRIPTION_PROVIDERS.includes(p)
        ? { kind: "flow", flow: methodStep(flow.statuses, p) }
        : { kind: "flow", flow: apiKeyStep(flow.statuses, p) }
    }
    case "method": {
      const method = selectedValue(flow.sel)
      if (method === undefined) return { kind: "none" }
      return method === "api_key"
        ? { kind: "flow", flow: apiKeyStep(flow.statuses, flow.provider) }
        : { kind: "startOAuth", provider: flow.provider, flow: oauthStep(flow.statuses, flow.provider) }
    }
    case "apiKey": {
      const key = flow.prompt.value.trim()
      return key.length === 0
        ? { kind: "none" }
        : { kind: "apiKey", provider: flow.provider, key }
    }
    case "oauth": {
      const redirect = flow.manual.value.trim()
      return redirect.length === 0
        ? { kind: "none" }
        : { kind: "oauthManual", provider: flow.provider, redirect }
    }
    case "localUrl": {
      const baseUrl = flow.prompt.value.trim()
      return baseUrl.length === 0
        ? { kind: "none" }
        : { kind: "localUrl", provider: flow.provider, baseUrl }
    }
  }
}
