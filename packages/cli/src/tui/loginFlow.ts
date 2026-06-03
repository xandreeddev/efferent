/**
 * The in-app `:login` flow as a **pure** state machine (pi-shaped): pick an
 * auth method → pick a provider (with per-provider status tags) → either paste
 * an API key or run the OAuth subscription flow. It composes the existing
 * `selectBox` (menu steps) and `promptBox` (text-entry steps); transitions are
 * pure and the driver performs the effects (persist a key, start OAuth) on the
 * `LoginAdvance` outcome it gets back.
 */

import { type Provider } from "@efferent/core"
import type { OverlayLine } from "./modal.js"
import {
  filterAppend,
  filterBackspace,
  moveSelect,
  openSelect,
  renderSelectBox,
  type SelectOption,
  type SelectState,
  selectedValue,
} from "./selectBox.js"
import {
  openPrompt,
  promptAppend,
  promptBackspace,
  type PromptState,
  renderPromptBox,
} from "./promptBox.js"

export type AuthMethod = "subscription" | "api_key"

/** What's already configured for a provider (drives the status tag). */
export interface ProviderStatus {
  readonly provider: Provider
  readonly configured: "api_key" | "oauth" | undefined
}

export type LoginFlow =
  | {
      readonly step: "authMethod"
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly sel: SelectState<AuthMethod>
    }
  | {
      readonly step: "provider"
      readonly method: AuthMethod
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly sel: SelectState<Provider>
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

/** What the driver must do after an Enter (the pure machine can't run effects). */
export type LoginAdvance =
  | { readonly kind: "flow"; readonly flow: LoginFlow }
  | { readonly kind: "apiKey"; readonly provider: Provider; readonly key: string }
  | { readonly kind: "startOAuth"; readonly provider: Provider; readonly flow: LoginFlow }
  | { readonly kind: "oauthManual"; readonly provider: Provider; readonly redirect: string }
  | { readonly kind: "none" }

const PROVIDER_LABEL: Record<Provider, string> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  opencode: "OpenCode",
}

// Anthropic and OpenAI expose subscription/OAuth flows; every provider accepts
// an API key.
const SUBSCRIPTION_PROVIDERS: ReadonlyArray<Provider> = ["anthropic", "openai"]
const API_KEY_PROVIDERS: ReadonlyArray<Provider> = ["anthropic", "google", "openai", "opencode"]

const statusTag = (s: ProviderStatus["configured"]): string =>
  s === "api_key" ? "✓ api key" : s === "oauth" ? "✓ subscription" : "• unconfigured"

const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + " ".repeat(n - s.length)

const providerStep = (
  method: AuthMethod,
  statuses: ReadonlyArray<ProviderStatus>,
): LoginFlow => {
  const allowed = method === "subscription" ? SUBSCRIPTION_PROVIDERS : API_KEY_PROVIDERS
  const options: ReadonlyArray<SelectOption<Provider>> = allowed.map((p) => {
    const configured = statuses.find((s) => s.provider === p)?.configured
    return {
      value: p,
      label: `${pad(PROVIDER_LABEL[p], 10)}  ${statusTag(configured)}`,
      active: configured !== undefined,
    }
  })
  return {
    step: "provider",
    method,
    statuses,
    sel: openSelect(
      method === "subscription" ? "Select a subscription provider" : "Select a provider",
      options,
    ),
  }
}

const apiKeyStep = (
  statuses: ReadonlyArray<ProviderStatus>,
  provider: Provider,
): LoginFlow => ({
  step: "apiKey",
  statuses,
  provider,
  prompt: openPrompt(`Log in to ${PROVIDER_LABEL[provider]}`, "Paste your API key", true),
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

export const openLogin = (statuses: ReadonlyArray<ProviderStatus>): LoginFlow => ({
  step: "authMethod",
  statuses,
  sel: openSelect("How do you want to log in?", [
    { value: "subscription", label: "Use a subscription (OAuth — Claude Pro/Max or ChatGPT)" },
    { value: "api_key", label: "Use an API key" },
  ]),
})

// NB: `authMethod` and `provider` get separate case bodies (not a fallthrough)
// so each `flow.sel` stays concretely typed — a shared body widens the union.
export const loginMove = (flow: LoginFlow, dir: "up" | "down"): LoginFlow => {
  switch (flow.step) {
    case "authMethod":
      return { ...flow, sel: moveSelect(flow.sel, dir) }
    case "provider":
      return { ...flow, sel: moveSelect(flow.sel, dir) }
    default:
      return flow
  }
}

export const loginAppend = (flow: LoginFlow, ch: string): LoginFlow => {
  switch (flow.step) {
    case "authMethod":
      return { ...flow, sel: filterAppend(flow.sel, ch) }
    case "provider":
      return { ...flow, sel: filterAppend(flow.sel, ch) }
    case "apiKey":
      return { ...flow, prompt: promptAppend(flow.prompt, ch) }
    case "oauth":
      return { ...flow, manual: promptAppend(flow.manual, ch) }
  }
}

export const loginBackspace = (flow: LoginFlow): LoginFlow => {
  switch (flow.step) {
    case "authMethod":
      return { ...flow, sel: filterBackspace(flow.sel) }
    case "provider":
      return { ...flow, sel: filterBackspace(flow.sel) }
    case "apiKey":
      return { ...flow, prompt: promptBackspace(flow.prompt) }
    case "oauth":
      return { ...flow, manual: promptBackspace(flow.manual) }
  }
}

/** Esc: step back one level, or `undefined` to close the flow entirely. */
export const loginBack = (flow: LoginFlow): LoginFlow | undefined => {
  switch (flow.step) {
    case "authMethod":
      return undefined
    case "provider":
      return openLogin(flow.statuses)
    case "apiKey":
      return providerStep("api_key", flow.statuses)
    case "oauth":
      return providerStep("subscription", flow.statuses)
  }
}

/** Update the OAuth step's status line (driver progress feedback). */
export const loginSetOAuthStatus = (flow: LoginFlow, status: string): LoginFlow =>
  flow.step === "oauth" ? { ...flow, status } : flow

export const loginAdvance = (flow: LoginFlow): LoginAdvance => {
  switch (flow.step) {
    case "authMethod": {
      const method = selectedValue(flow.sel)
      return method === undefined
        ? { kind: "none" }
        : { kind: "flow", flow: providerStep(method, flow.statuses) }
    }
    case "provider": {
      const provider = selectedValue(flow.sel)
      if (provider === undefined) return { kind: "none" }
      return flow.method === "api_key"
        ? { kind: "flow", flow: apiKeyStep(flow.statuses, provider) }
        : { kind: "startOAuth", provider, flow: oauthStep(flow.statuses, provider) }
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
  }
}

/** Render the active step's overlay. */
export const renderLoginFlow = (
  flow: LoginFlow,
  termRows: number,
  termCols: number,
): OverlayLine[] => {
  switch (flow.step) {
    case "authMethod":
    case "provider":
      return renderSelectBox(flow.sel, termRows, termCols)
    case "apiKey":
      return renderPromptBox(flow.prompt, termRows, termCols)
    case "oauth":
      return renderPromptBox(
        { ...flow.manual, prompt: `${flow.status} — ${flow.manual.prompt}` },
        termRows,
        termCols,
      )
  }
}
