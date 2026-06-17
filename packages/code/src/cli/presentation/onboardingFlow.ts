import type { ModelInfo } from "@xandreed/sdk-core"
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
import { themes } from "./theme/themes.js"

export type OnboardingStep =
  | "login"
  | "mainModel"
  | "fastModel"
  | "theme"
  | "complete"

export type OnboardingState =
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
      readonly step: "complete"
      readonly statuses: ReadonlyArray<ProviderStatus>
    }

export const startOnboarding = (statuses: ReadonlyArray<ProviderStatus>): OnboardingState => ({
  step: "login",
  statuses,
  flow: openLogin(statuses),
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
    sel: openSelect("Select main model (Esc to skip)", options),
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
    sel: openSelect("Select FAST model (Esc to skip)", options),
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
    sel: openSelect("Select color theme (Esc to skip)", options),
  }
}

export const onboardingToComplete = (state: OnboardingState): OnboardingState => ({
  step: "complete",
  statuses: state.statuses,
})

export const onboardingMove = (state: OnboardingState, dir: "up" | "down"): OnboardingState => {
  switch (state.step) {
    case "login":
      return { ...state, flow: loginMove(state.flow, dir) }
    case "mainModel":
      return { ...state, sel: moveSelect(state.sel, dir) }
    case "fastModel":
      return { ...state, sel: moveSelect(state.sel, dir) }
    case "theme":
      return { ...state, sel: moveSelect(state.sel, dir) }
    default:
      return state
  }
}

export const onboardingAppend = (state: OnboardingState, ch: string): OnboardingState => {
  switch (state.step) {
    case "login":
      return { ...state, flow: loginAppend(state.flow, ch) }
    case "mainModel":
      return { ...state, sel: filterAppend(state.sel, ch) }
    case "fastModel":
      return { ...state, sel: filterAppend(state.sel, ch) }
    case "theme":
      return { ...state, sel: filterAppend(state.sel, ch) }
    default:
      return state
  }
}

export const onboardingBackspace = (state: OnboardingState): OnboardingState => {
  switch (state.step) {
    case "login":
      return { ...state, flow: loginBackspace(state.flow) }
    case "mainModel":
      return { ...state, sel: filterBackspace(state.sel) }
    case "fastModel":
      return { ...state, sel: filterBackspace(state.sel) }
    case "theme":
      return { ...state, sel: filterBackspace(state.sel) }
    default:
      return state
  }
}
