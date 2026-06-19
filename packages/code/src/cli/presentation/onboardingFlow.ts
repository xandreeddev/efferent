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
  type SelectState,
} from "./selectBox.js"
import { openPrompt, promptAppend, promptBackspace, type PromptState } from "./promptBox.js"
import { themes } from "./theme/themes.js"
import { glyph } from "./theme/glyphs.js"
import { connLabel, type DbKind, type NamedConn } from "@xandreed/sdk-core"

export type OnboardingStep =
  | "scope"
  | "login"
  | "mainModel"
  | "fastModel"
  | "theme"
  | "database"
  | "complete"

/** A row in the database manager: use/make-default a configured connection, add
 *  a new local or remote one, or finish. Mirrors the provider list in `:login`. */
export type DbManagerItem =
  | { readonly tag: "use"; readonly conn: NamedConn }
  | { readonly tag: "addLocal" }
  | { readonly tag: "addRemote" }
  | { readonly tag: "done" }

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
      /** The manager list (configured connections + add/done rows). */
      readonly sel: SelectState<DbManagerItem>
      /** Present while adding/editing — the path (local) / connection-string
       *  (remote) prompt; `adding` says which, to interpret the value + hint. */
      readonly connect?: PromptState
      readonly adding?: "local" | "remote"
      /** When set, the prompt is EDITING this existing connection (keep its name)
       *  rather than adding a new one. */
      readonly editName?: string | undefined
      /** When set, a delete is awaiting confirmation for this connection name —
       *  the manager shows a "Remove <name>? ↵ confirm · esc cancel" line instead
       *  of acting on a bare keypress (so an accidental key can't drop a DB). */
      readonly confirmRemove?: string | undefined
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

/** Step 6: the database **manager** — configure as many connections as you want
 *  (local + remote) and pick the default, mirroring the providers/API-keys step.
 *  `conns` is every configured connection (implicit `local` first); `activeName`
 *  is the default, marked `◀ default`. */
export const onboardingToDatabase = (
  state: OnboardingState,
  conns: ReadonlyArray<NamedConn>,
  activeName: string,
): OnboardingState => ({
  step: "database",
  statuses: state.statuses,
  sel: openSelect<DbManagerItem>("Step 6 of 6 · Databases", [
    // Configured connections first — the default marked, so the active store is
    // always visible at a glance.
    ...conns.map((c) => ({
      value: { tag: "use", conn: c } as DbManagerItem,
      label: connLabel(c.name, c.kind),
      section: "configured",
      active: c.name === activeName,
      tag: c.name === activeName ? "default" : undefined,
    })),
    // Then the two add actions, grouped under one heading.
    {
      value: { tag: "addRemote" } as DbManagerItem,
      label: `${glyph.add} Remote database (Postgres)`,
      section: "add a database",
      action: true,
    },
    {
      value: { tag: "addLocal" } as DbManagerItem,
      label: `${glyph.add} Local database (SQLite)`,
      section: "add a database",
      action: true,
    },
    // …and a bare "done" separator row to finish.
    { value: { tag: "done" } as DbManagerItem, label: `${glyph.ok} Done`, section: "", action: true },
  ]),
})

/** Open the add prompt: a postgres connection string (`remote`, masked) or a
 *  SQLite file path (`local`, prefilled with the default, unmasked — like the
 *  ollama base-URL step). */
export const databaseAdd = (
  state: Extract<OnboardingState, { step: "database" }>,
  adding: "local" | "remote",
  defaultLocalPath: string,
): OnboardingState => {
  const { editName: _drop, ...rest } = state // a fresh add is never an edit
  return {
    ...rest,
    adding,
    connect:
      adding === "remote"
        ? openPrompt("Step 6 of 6 · Add a remote database", "Paste your postgres:// connection string", true)
        : openPrompt("Step 6 of 6 · Add a local database", "Database file path", false, defaultLocalPath),
  }
}

/** Arm a delete confirmation for `name` (the manager renders the confirm line;
 *  ↵ confirms, esc cancels). Keeps search free — delete is no longer a bare key. */
export const databaseConfirmRemove = (
  state: Extract<OnboardingState, { step: "database" }>,
  name: string,
): OnboardingState => ({ ...state, confirmRemove: name })

/** Clear a pending delete confirmation (esc / acted). */
export const databaseCancelRemove = (
  state: Extract<OnboardingState, { step: "database" }>,
): OnboardingState => {
  const { confirmRemove: _drop, ...rest } = state
  return rest
}

/** Open the prompt to EDIT an existing connection, prefilled with its current
 *  url/path (postgres masked, like the add-remote step). Keeps its name on save. */
export const databaseEdit = (
  state: Extract<OnboardingState, { step: "database" }>,
  conn: NamedConn,
): OnboardingState => ({
  ...state,
  adding: conn.kind === "postgres" ? "remote" : "local",
  editName: conn.name,
  connect:
    conn.kind === "postgres"
      ? openPrompt(`Step 6 of 6 · Edit ${conn.name}`, "Edit the postgres:// connection string", true, conn.url)
      : openPrompt(`Step 6 of 6 · Edit ${conn.name}`, "Database file path", false, conn.url),
})

/** Leave the add prompt, back to the manager list (rebuilt from `conns`). */
export const databaseToManage = onboardingToDatabase

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
