import type { Effect } from "effect"
import type {
  AuthStore,
  ConversationStore,
  FileSystem,
  Http,
  LlmInfo,
  ModelRegistry,
  SettingsStore,
  Shell,
  WebSearch,
} from "@efferent/core"
import type { LanguageModel } from "@effect/ai"
import type { TuiStore } from "./state/store.js"

/**
 * Every domain service the captured Effect runtime provides — the R-channel of
 * the UI⇄Effect bridge (the same one the old TUI captured at `tui.ts:3558`).
 * Domain state lives behind these services (Effect side); UI state lives in the
 * signal store (Solid side). The only crossings are `ctx.run` (UI→Effect, here)
 * and the event pump (Effect→signals, `events/eventPump.ts`).
 */
export type AppServices =
  | FileSystem
  | Http
  | Shell
  | ConversationStore
  | LanguageModel.LanguageModel
  | SettingsStore
  | ModelRegistry
  | WebSearch
  | AuthStore
  | LlmInfo

/**
 * The single handle the whole view tree consumes. `run` bridges UI→Effect (any
 * program requiring a subset of `AppServices`); `submit`/`interrupt`/`exit` are
 * lifted high-level actions; `store` is the reactive UI state. Constructed once
 * in `runtime.ts` and threaded through props — never a global.
 */
export interface TuiContext {
  readonly store: TuiStore
  readonly run: <A, E>(program: Effect.Effect<A, E, AppServices>) => Promise<A>
  readonly submit: (text: string) => void
  readonly interrupt: () => void
  readonly exit: () => void
  /**
   * Copy the current OpenTUI mouse selection to the system clipboard (OSC 52).
   * Returns false when nothing is selected. Bound to `y` on the read-only panes
   * — the non-vim copy path (OpenTUI owns mouse drag-select; this yanks it).
   */
  readonly copySelection: () => boolean
}
