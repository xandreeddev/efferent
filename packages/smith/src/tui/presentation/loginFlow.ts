import { Match, Option } from "effect"
import {
  filterAppend,
  filterBackspace,
  moveSelect,
  openSelect,
  selectedValue,
} from "./selectBox.js"
import type { SelectOption, SelectState } from "./selectBox.js"
import { openPrompt, promptAppend, promptBackspace } from "./promptBox.js"
import type { PromptState } from "./promptBox.js"

/**
 * The in-app `:login` flow as a PURE state machine, shaped as a provider
 * manager: the home screen lists every provider with its configured status;
 * pick one → choose a method (anthropic only — the one provider with a
 * wired subscription flow) → paste a key or run the OAuth flow → land back
 * on home with the new status tag. Transitions are pure; the driver
 * (`actions/login.ts`) performs the effects on the `LoginAdvance` outcome.
 */

export type SmithProvider = "anthropic" | "openai" | "google" | "opencode"

export type AuthMethod = "subscription" | "api_key"

/** What's already configured for a provider (drives the status tag). */
export interface ProviderStatus {
  readonly provider: SmithProvider
  readonly configured: Option.Option<"api_key" | "oauth" | "local">
}

export type LoginHomeItem =
  | { readonly tag: "provider"; readonly provider: SmithProvider }
  | { readonly tag: "done" }

export interface LoginHome {
  readonly step: "home"
  readonly statuses: ReadonlyArray<ProviderStatus>
  readonly sel: SelectState<LoginHomeItem>
}
export interface LoginMethod {
  readonly step: "method"
  readonly statuses: ReadonlyArray<ProviderStatus>
  readonly provider: SmithProvider
  readonly sel: SelectState<AuthMethod>
}
export interface LoginApiKey {
  readonly step: "apiKey"
  readonly statuses: ReadonlyArray<ProviderStatus>
  readonly provider: SmithProvider
  readonly prompt: PromptState
}
export interface LoginOauth {
  readonly step: "oauth"
  readonly statuses: ReadonlyArray<ProviderStatus>
  readonly provider: SmithProvider
  /** Driver progress feedback ("Opening your browser…", "Waiting…"). */
  readonly status: string
  /** The authorize URL, shown so a headless/remote user can visit it by hand. */
  readonly authorizeUrl: string
  readonly manual: PromptState
}

export type LoginFlow = LoginHome | LoginMethod | LoginApiKey | LoginOauth

/** What the driver must do after an Enter (the pure machine can't run effects). */
export type LoginAdvance =
  | { readonly kind: "flow"; readonly flow: LoginFlow }
  | { readonly kind: "apiKey"; readonly provider: SmithProvider; readonly key: string }
  | { readonly kind: "startOAuth"; readonly provider: SmithProvider }
  | { readonly kind: "oauthManual"; readonly provider: SmithProvider; readonly redirect: string }
  | { readonly kind: "done" }
  | { readonly kind: "none" }

const PROVIDER_LABEL: Record<SmithProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  opencode: "OpenCode",
}

/** Display order on the home manager. */
const HOME_PROVIDERS: ReadonlyArray<SmithProvider> = [
  "anthropic",
  "openai",
  "google",
  "opencode",
]

/** Only anthropic has a wired subscription (OAuth) flow on the new line. */
const SUBSCRIPTION_PROVIDERS: ReadonlyArray<SmithProvider> = ["anthropic"]

const statusWord = (s: ProviderStatus["configured"]): Option.Option<string> =>
  Option.map(s, (kind) =>
    kind === "api_key" ? "api key" : kind === "oauth" ? "subscription" : "local",
  )

/** The home manager: every provider with its status, then a `done` row.
 *  Rebuilt after each login so the tags reflect what's now configured. */
export const homeStep = (statuses: ReadonlyArray<ProviderStatus>): LoginFlow => {
  const options: ReadonlyArray<SelectOption<LoginHomeItem>> = [
    ...HOME_PROVIDERS.map((p) => {
      const configured = Option.flatMap(
        Option.fromNullable(statuses.find((s) => s.provider === p)),
        (s) => s.configured,
      )
      return {
        value: { tag: "provider", provider: p } as LoginHomeItem,
        label: PROVIDER_LABEL[p],
        active: Option.isSome(configured),
        tag: Option.getOrUndefined(statusWord(configured)),
      }
    }),
    { value: { tag: "done" } as LoginHomeItem, label: "✓ Done", action: true },
  ]
  return { step: "home", statuses, sel: openSelect("Sign in to your providers", options) }
}

const methodStep = (
  statuses: ReadonlyArray<ProviderStatus>,
  provider: SmithProvider,
): LoginFlow => ({
  step: "method",
  statuses,
  provider,
  sel: openSelect(`Log in to ${PROVIDER_LABEL[provider]}`, [
    { value: "subscription", label: "Use a subscription (OAuth — Claude Pro/Max)" },
    { value: "api_key", label: "Use an API key" },
  ]),
})

const apiKeyStep = (
  statuses: ReadonlyArray<ProviderStatus>,
  provider: SmithProvider,
): LoginFlow => ({
  step: "apiKey",
  statuses,
  provider,
  prompt: openPrompt(`Log in to ${PROVIDER_LABEL[provider]}`, "Paste your API key", true),
})

export const oauthStep = (
  statuses: ReadonlyArray<ProviderStatus>,
  provider: SmithProvider,
  authorizeUrl: string,
  status = "Opening your browser…",
): LoginFlow => ({
  step: "oauth",
  statuses,
  provider,
  status,
  authorizeUrl,
  manual: openPrompt(
    `Log in to ${PROVIDER_LABEL[provider]}`,
    "or paste the redirect URL here",
    false,
  ),
})

/** Open the login manager, tagging which providers are already configured. */
export const openLogin = (statuses: ReadonlyArray<ProviderStatus>): LoginFlow =>
  homeStep(statuses)

export const loginMove = (flow: LoginFlow, dir: "up" | "down"): LoginFlow =>
  Match.value(flow).pipe(
    Match.when({ step: "home" }, (f) => ({ ...f, sel: moveSelect(f.sel, dir) })),
    Match.when({ step: "method" }, (f) => ({ ...f, sel: moveSelect(f.sel, dir) })),
    Match.orElse(() => flow),
  )

export const loginAppend = (flow: LoginFlow, ch: string): LoginFlow =>
  Match.value(flow).pipe(
    Match.when({ step: "home" }, (f) => ({ ...f, sel: filterAppend(f.sel, ch) })),
    Match.when({ step: "method" }, (f) => ({ ...f, sel: filterAppend(f.sel, ch) })),
    Match.when({ step: "apiKey" }, (f) => ({ ...f, prompt: promptAppend(f.prompt, ch) })),
    Match.when({ step: "oauth" }, (f) => ({ ...f, manual: promptAppend(f.manual, ch) })),
    Match.exhaustive,
  )

export const loginBackspace = (flow: LoginFlow): LoginFlow =>
  Match.value(flow).pipe(
    Match.when({ step: "home" }, (f) => ({ ...f, sel: filterBackspace(f.sel) })),
    Match.when({ step: "method" }, (f) => ({ ...f, sel: filterBackspace(f.sel) })),
    Match.when({ step: "apiKey" }, (f) => ({ ...f, prompt: promptBackspace(f.prompt) })),
    Match.when({ step: "oauth" }, (f) => ({ ...f, manual: promptBackspace(f.manual) })),
    Match.exhaustive,
  )

/** Esc: step back one level; `None` closes the flow entirely. */
export const loginBack = (flow: LoginFlow): Option.Option<LoginFlow> =>
  Match.value(flow).pipe(
    Match.when({ step: "home" }, () => Option.none<LoginFlow>()),
    Match.when({ step: "method" }, (f) => Option.some(homeStep(f.statuses))),
    Match.when({ step: "apiKey" }, (f) =>
      // Reached via the method choice only for subscription-capable providers.
      Option.some(
        SUBSCRIPTION_PROVIDERS.includes(f.provider)
          ? methodStep(f.statuses, f.provider)
          : homeStep(f.statuses),
      ),
    ),
    Match.when({ step: "oauth" }, (f) => Option.some(methodStep(f.statuses, f.provider))),
    Match.exhaustive,
  )

/** Update the OAuth step's status line (driver progress feedback). */
export const loginSetOAuthStatus = (flow: LoginFlow, status: string): LoginFlow =>
  flow.step === "oauth" ? { ...flow, status } : flow

export const loginAdvance = (flow: LoginFlow): LoginAdvance =>
  Match.value(flow).pipe(
    Match.when({ step: "home" }, (f) =>
      Option.match(selectedValue(f.sel), {
        onNone: (): LoginAdvance => ({ kind: "none" }),
        onSome: (item): LoginAdvance =>
          item.tag === "done"
            ? { kind: "done" }
            : SUBSCRIPTION_PROVIDERS.includes(item.provider)
              ? { kind: "flow", flow: methodStep(f.statuses, item.provider) }
              : { kind: "flow", flow: apiKeyStep(f.statuses, item.provider) },
      }),
    ),
    Match.when({ step: "method" }, (f) =>
      Option.match(selectedValue(f.sel), {
        onNone: (): LoginAdvance => ({ kind: "none" }),
        onSome: (method): LoginAdvance =>
          method === "api_key"
            ? { kind: "flow", flow: apiKeyStep(f.statuses, f.provider) }
            : { kind: "startOAuth", provider: f.provider },
      }),
    ),
    Match.when({ step: "apiKey" }, (f): LoginAdvance => {
      const key = f.prompt.value.trim()
      return key.length === 0 ? { kind: "none" } : { kind: "apiKey", provider: f.provider, key }
    }),
    Match.when({ step: "oauth" }, (f): LoginAdvance => {
      const redirect = f.manual.value.trim()
      return redirect.length === 0
        ? { kind: "none" }
        : { kind: "oauthManual", provider: f.provider, redirect }
    }),
    Match.exhaustive,
  )
