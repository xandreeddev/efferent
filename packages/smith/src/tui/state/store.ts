import { batch, createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import { Option } from "effect"
import type { Effect } from "effect"
import type { SettingsStore, SpecDoc } from "@xandreed/engine"
import type { SmithEvent } from "../../domain/SmithEvent.js"
import type { SmithRunConfig } from "../../domain/SmithConfig.js"
import type { FloorState } from "../presentation/floor.js"
import { initialFloor, reduceFloor } from "../presentation/floor.js"
import type { RefineState } from "../presentation/refine.js"
import { initialRefine, reduceRefine, withUserLine } from "../presentation/refine.js"

export interface RolesReadout {
  readonly general: string
  readonly code: string
  readonly fast: string
}

export type SmithMode = "refine" | "forge"

export interface SmithStore {
  readonly floor: Accessor<FloorState>
  /** Fold one event into BOTH view models (Solid-batched by the pump). */
  readonly reduce: (event: SmithEvent) => void
  readonly mode: Accessor<SmithMode>
  readonly setMode: (mode: SmithMode) => void
  readonly refine: Accessor<RefineState>
  readonly addUserLine: (text: string) => void
  readonly busy: Accessor<boolean>
  readonly setBusy: (busy: boolean) => void
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
  /** Refine mode: one composer submission = one refiner turn. */
  readonly sendRefine?: (text: string) => void
  /** Refine mode: `:lock` — the human's approval. */
  readonly lock?: () => void
  /** Refine mode: `:forge` — transition to the forge on the locked spec. */
  readonly forge?: () => void
}

export const createSmithStore = (
  run: SmithRunConfig,
  roles: RolesReadout,
  mode: SmithMode = "forge",
): SmithStore => {
  const [floor, setFloor] = createSignal<FloorState>(
    initialFloor(run.task, run.maxAttempts),
  )
  const [refine, setRefine] = createSignal<RefineState>(initialRefine)
  const [modeSig, setModeSig] = createSignal<SmithMode>(mode)
  const [busy, setBusySig] = createSignal(false)
  const [spinner, setSpinner] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  const [exitCode, setExitCodeSig] = createSignal<number | undefined>(undefined)
  return {
    floor,
    reduce: (event) =>
      batch(() => {
        setFloor((state) => reduceFloor(state, event))
        setRefine((state) => reduceRefine(state, event))
      }),
    mode: modeSig,
    setMode: (next) => setModeSig(next),
    refine,
    addUserLine: (text) => setRefine((state) => withUserLine(state, text)),
    busy,
    setBusy: (value) => setBusySig(value),
    spinner,
    tickSpinner: () => setSpinner((n) => n + 1),
    notice,
    setNotice,
    exitCode,
    setExitCode: (code) => setExitCodeSig(code),
    roles,
  }
}

/** The locked-spec summary line the forge mode pins under the header. */
export const specChip = (doc: Option.Option<SpecDoc>): string =>
  Option.match(doc, {
    onNone: () => "",
    onSome: (d) =>
      `spec ${d.slug} (${d.status}) · ${d.acceptance.length} criteria · ${d.checks.length} checks`,
  })
