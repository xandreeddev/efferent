import type { ConfigScope, ModelInfo } from "@xandreed/sdk-core"
import {
  openLogin,
  loginMove,
  loginAppend,
  loginBackspace,
  loginBack,
  loginAdvance,
  type LoginFlow,
  type ProviderStatus,
} from "./loginFlow.js"
import {
  openSelect,
  moveSelect,
  filterAppend,
  filterBackspace,
  selectedValue,
  type SelectState,
} from "./selectBox.js"
import { openPrompt, promptAppend, promptBackspace, type PromptState } from "./promptBox.js"
import { themes } from "./theme/themes.js"

export type OnboardingStep =
  | "scope"
  | "login"
  | "mainModel"
  | "fastModel"
  | "theme"
  | "database"
  | "complete"

/** Conversation-store choice on the database step. */
export type DbChoice = "local" | "remote"

export type OnboardingState =
  | {
      readonly step: "scope"
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly sel: SelectState<ConfigScope>
    }
  | {
      readonly step: "login"
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly flow: LoginFlow
    }
  | {
      readonly step: "mainModel"
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly sel: SelectState<ModelInfo>
    }
  | {
      readonly step: "fastModel"
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly sel: SelectState<ModelInfo | null>
    }
  | {
      readonly step: "theme"
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly sel: SelectState<string>
    }
  | {
      readonly step: "database"
      readonly statuses: ReadonlyArray<ProviderStatus>
      readonly sel: SelectState<DbChoice>
      /** Present once "remote" is chosen — the connection-string prompt. */
      readonly connect?: PromptState
    }
  | {
      readonly step: "complete"
      readonly statuses: ReadonlyArray<ProviderStatus>
    }

/** Step 1: choose whether this setup is machine-wide or just this folder.
 *  `currentScope` pre-selects the matching row — so stepping BACK into this
 *  screen restores the previously-chosen scope instead of resetting to global. */
export const startOnboarding = (
  statuses: ReadonlyArray<ProviderStatus>,
  currentScope?: ConfigScope,
): OnboardingState => ({
  step: "scope",
  statuses,
  sel: openSelect<ConfigScope>("Step 1 of 6 · Where should this setup live?", [
    { value: "global", label: "This machine — every project (global)", active: (currentScope ?? "global") === "global" },
    { value: "local", label: "Just this folder (local, gitignored)", active: currentScope === "local" },
  ]),
})

/** Step 2: the credential/login flow (after the scope is chosen). */
export const onboardingToLogin = (state: OnboardingState): OnboardingState => ({
  step: "login",
  statuses: state.statuses,
  flow: openLogin(state.statuses),
})

export const onboardingToMainModel = (
  state: OnboardingState,
  models: ReadonlyArray<ModelInfo>,
  activeModel?: string,
): OnboardingState => {
  const options = models.map((m) => ({
    value: m,
    label: `${m.provider}:${m.modelId}`,
    active: activeModel !== undefined && `${m.provider}:${m.modelId}` === activeModel,
  }))
  return {
    step: "mainModel",
    statuses: state.statuses,
    sel: openSelect("Step 3 of 6 · Select your main model", options),
  }
}

export const onboardingToFastModel = (
  state: OnboardingState,
  models: ReadonlyArray<ModelInfo>,
  activeFastModel?: string,
): OnboardingState => {
  const options = [
    { value: null, label: "default (follow main)", active: activeFastModel === undefined },
    ...models.map((m) => ({
      value: m,
      label: `${m.provider}:${m.modelId}`,
      active: activeFastModel !== undefined && `${m.provider}:${m.modelId}` === activeFastModel,
    })),
  ]
  return {
    step: "fastModel",
    statuses: state.statuses,
    sel: openSelect("Step 4 of 6 · Select your fast (helper) model", options),
  }
}

export const onboardingToTheme = (state: OnboardingState, activeTheme: string): OnboardingState => {
  const options = Object.keys(themes).map((t) => ({
    value: t,
    label: t,
    active: t === activeTheme,
  }))
  return {
    step: "theme",
    statuses: state.statuses,
    sel: openSelect("Step 5 of 6 · Pick a color theme", options),
  }
}

/** Step 6: where conversations are stored — local SQLite (default) or a remote
 *  Postgres (Neon/Supabase/…). `currentDbUrl` pre-selects the matching row. */
export const onboardingToDatabase = (
  state: OnboardingState,
  currentDbUrl?: string,
): OnboardingState => {
  const isRemote = currentDbUrl !== undefined && /^postgres(ql)?:\/\//i.test(currentDbUrl)
  return {
    step: "database",
    statuses: state.statuses,
    sel: openSelect<DbChoice>("Step 6 of 6 · Where should conversations be stored?", [
      { value: "local", label: "Local file (SQLite) — default or custom path", active: !isRemote },
      { value: "remote", label: "Remote Postgres (Neon, Supabase, …)", active: isRemote },
    ]),
  }
}

/** Enter the prompt after a storage option is chosen: a postgres connection
 *  string for "remote" (masked), or a SQLite file path for "local". The local
 *  prompt is **prefilled with the default path** (`defaultLocalPath`, unmasked) —
 *  mirroring the ollama base-URL step — so Enter accepts it or you edit it. The
 *  choice stays on `sel`, read back when submitting. */
export const databaseToConnect = (
  state: Extract<OnboardingState, { step: "database" }>,
  defaultLocalPath: string,
): OnboardingState => ({
  ...state,
  connect:
    (selectedValue(state.sel) ?? "local") === "remote"
      ? openPrompt("Step 6 of 6 · Connect to Postgres", "Paste your postgres:// connection string", true)
      : openPrompt("Step 6 of 6 · SQLite file location", "Database file path", false, defaultLocalPath),
})

export const onboardingToComplete = (state: OnboardingState): OnboardingState => ({
  step: "complete",
  statuses: state.statuses,
})

export const onboardingMove = (state: OnboardingState, dir: "up" | "down"): OnboardingState => {
  switch (state.step) {
    case "scope":
      return { ...state, sel: moveSelect(state.sel, dir) }
    case "login":
      return { ...state, flow: loginMove(state.flow, dir) }
    case "mainModel":
      return { ...state, sel: moveSelect(state.sel, dir) }
    case "fastModel":
      return { ...state, sel: moveSelect(state.sel, dir) }
    case "theme":
      return { ...state, sel: moveSelect(state.sel, dir) }
    case "database":
      // In connect (prompt) mode there's nothing to move; in choose mode move the list.
      return state.connect !== undefined ? state : { ...state, sel: moveSelect(state.sel, dir) }
    default:
      return state
  }
}

export const onboardingAppend = (state: OnboardingState, ch: string): OnboardingState => {
  switch (state.step) {
    case "scope":
      return { ...state, sel: filterAppend(state.sel, ch) }
    case "login":
      return { ...state, flow: loginAppend(state.flow, ch) }
    case "mainModel":
      return { ...state, sel: filterAppend(state.sel, ch) }
    case "fastModel":
      return { ...state, sel: filterAppend(state.sel, ch) }
    case "theme":
      return { ...state, sel: filterAppend(state.sel, ch) }
    case "database":
      return state.connect !== undefined
        ? { ...state, connect: promptAppend(state.connect, ch) }
        : { ...state, sel: filterAppend(state.sel, ch) }
    default:
      return state
  }
}

export const onboardingBackspace = (state: OnboardingState): OnboardingState => {
  switch (state.step) {
    case "scope":
      return { ...state, sel: filterBackspace(state.sel) }
    case "login":
      return { ...state, flow: loginBackspace(state.flow) }
    case "mainModel":
      return { ...state, sel: filterBackspace(state.sel) }
    case "fastModel":
      return { ...state, sel: filterBackspace(state.sel) }
    case "theme":
      return { ...state, sel: filterBackspace(state.sel) }
    case "database":
      return state.connect !== undefined
        ? { ...state, connect: promptBackspace(state.connect) }
        : { ...state, sel: filterBackspace(state.sel) }
    default:
      return state
  }
}
