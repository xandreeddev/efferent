import { batch, createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import type { Effect } from "effect"
import type { SettingsStore } from "@xandreed/sdk-core"
import type { SmithEvent } from "../../domain/SmithEvent.js"
import type { SmithRunConfig } from "../../domain/SmithConfig.js"
import type { FloorState } from "../presentation/floor.js"
import { initialFloor, reduceFloor } from "../presentation/floor.js"

export interface RolesReadout {
  readonly general: string
  readonly code: string
  readonly fast: string
}

export interface SmithStore {
  readonly floor: Accessor<FloorState>
  /** Fold one event into the floor (wrapped in a Solid batch by the pump). */
  readonly reduce: (event: SmithEvent) => void
  readonly spinner: Accessor<number>
  readonly tickSpinner: () => void
  /** One-line transient note (command feedback, interrupt notice). */
  readonly notice: Accessor<string>
  readonly setNotice: (text: string) => void
  /** The session fiber's exit code once it finished naturally. */
  readonly exitCode: Accessor<number | undefined>
  readonly setExitCode: (code: number) => void
  readonly roles: RolesReadout
}

export interface SmithTuiContext {
  readonly store: SmithStore
  readonly runConfig: SmithRunConfig
  /** UI→Effect bridge (the captured Runtime); commands reach the SettingsStore. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, SettingsStore>) => Promise<A>
  /** Interrupt the running forge session (Esc). */
  readonly interrupt: () => void
  /** End the TUI with an exit code (`:quit`, Ctrl-C). */
  readonly exit: (code: number) => void
}

export const createSmithStore = (run: SmithRunConfig, roles: RolesReadout): SmithStore => {
  const [floor, setFloor] = createSignal<FloorState>(
    initialFloor(run.task, run.maxAttempts),
  )
  const [spinner, setSpinner] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  const [exitCode, setExitCodeSig] = createSignal<number | undefined>(undefined)
  return {
    floor,
    reduce: (event) => batch(() => setFloor((state) => reduceFloor(state, event))),
    spinner,
    tickSpinner: () => setSpinner((n) => n + 1),
    notice,
    setNotice,
    exitCode,
    setExitCode: (code) => setExitCodeSig(code),
    roles,
  }
}
