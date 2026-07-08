import { batch, createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import { Option } from "effect"
import type { Effect } from "effect"
import type { AuthStore, FileSystem, ModelRole, SettingsStore, Shell, SpecDoc } from "@xandreed/engine"
import type { SmithEvent } from "../../domain/SmithEvent.js"
import type { SmithRunConfig } from "../../domain/SmithConfig.js"
import type { FloorState } from "../presentation/floor.js"
import { initialFloor, reduceFloor } from "../presentation/floor.js"
import type { RefineState } from "../presentation/refine.js"
import { initialRefine, reduceRefine, withUserLine } from "../presentation/refine.js"
import type { WorkspaceView } from "../presentation/workspace.js"
import { emptyWorkspace } from "../presentation/workspace.js"
import type { LoginFlow } from "../presentation/loginFlow.js"
import type { SelectState } from "../presentation/selectBox.js"

export interface RolesReadout {
  readonly general: string
  readonly code: string
  readonly fast: string
}

/** idle = the persistent workspace dashboard (`bare smith`). */
export type SmithMode = "idle" | "refine" | "forge"

/** What a picker Enter means (routes `submitSelect` in the key handler). */
export type SelectPurpose =
  | { readonly tag: "model"; readonly role: ModelRole }
  | { readonly tag: "logout" }

/** ONE inline contextual surface at a time — select picker or the login
 *  flow; while open, the composer unmounts and keys route here. */
export type Overlay =
  | { readonly kind: "none" }
  | {
      readonly kind: "select"
      readonly purpose: SelectPurpose
      readonly sel: SelectState<Option.Option<string>>
    }
  | { readonly kind: "login"; readonly flow: LoginFlow }

/** An in-flight OAuth authorization the driver races (callback vs paste). */
export interface OAuthSession {
  readonly verifier: string
  /** Interrupt the waiter fiber + close the loopback server. */
  readonly stop: () => void
}

/** Everything a TUI action may reach through `ctx.run`. */
export type SmithUiServices = SettingsStore | AuthStore | FileSystem | Shell

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
  /** Epoch ms when the current turn/run started (0 = idle) — the elapsed
   *  readout that makes a SLOW model call visible instead of dead air. */
  readonly busySince: Accessor<number>
  /** Epoch ms of the last agent event — silence beyond a threshold renders
   *  the "model is slow" hint. */
  readonly lastEventAt: Accessor<number>
  /** The composer registers a text reader so the : palette can follow it. */
  readonly registerComposerRead: (read: () => string) => void
  readonly composerText: () => string
  readonly spinner: Accessor<number>
  readonly tickSpinner: () => void
  /** One-line transient note (command feedback, interrupt notice). */
  readonly notice: Accessor<string>
  readonly setNotice: (text: string) => void
  /** The session fiber's exit code once it finished naturally. */
  readonly exitCode: Accessor<number | undefined>
  readonly setExitCode: (code: number) => void
  readonly roles: Accessor<RolesReadout>
  readonly setRoles: (roles: RolesReadout) => void
  /** The inline contextual surface (picker / login) — ONE at a time. */
  readonly overlay: Accessor<Overlay>
  readonly setOverlay: (overlay: Overlay) => void
  readonly closeOverlay: () => void
  /** The in-flight OAuth authorization, if any (Esc/exit tears it down). */
  readonly oauth: Accessor<Option.Option<OAuthSession>>
  readonly setOauth: (session: Option.Option<OAuthSession>) => void
  /** The composer registers its clear so the Esc rule can reach it. */
  readonly registerComposerClear: (clear: () => void) => void
  readonly clearComposer: () => void
  /** The workspace dashboard (idle mode): specs · runs · lessons. */
  readonly workspace: Accessor<WorkspaceView>
  readonly setWorkspace: (view: WorkspaceView) => void
  /** Fresh floor for the NEXT forge run (a persistent session runs many). */
  readonly resetFloor: (task: string, maxAttempts: number) => void
  /** Fresh refine state for the NEXT idea. */
  readonly resetRefine: () => void
}

export interface SmithTuiContext {
  readonly store: SmithStore
  readonly runConfig: SmithRunConfig
  /** UI→Effect bridge (the captured Runtime); actions reach settings/auth/fs/shell. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, SmithUiServices>) => Promise<A>
  /** Interrupt the running forge session (Esc). */
  readonly interrupt: () => void
  /** End the TUI with an exit code (`:quit`, Ctrl-C). */
  readonly exit: (code: number) => void
  /** Refine mode: one composer submission = one refiner turn. */
  readonly sendRefine?: (text: string) => void
  /** Refine mode: `:lock` — the human's approval. */
  readonly lock?: () => void
  /** `:forge [slug]` — forge the locked draft, or a named locked spec. */
  readonly forge?: (slug?: string) => void
  /** Workspace mode: plain composer text — starts/continues a refine. */
  readonly sendText?: (text: string) => void
  /** Workspace mode: `:new` — drop the current draft, back to the dashboard. */
  readonly newSpec?: () => void
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
  const [workspace, setWorkspaceSig] = createSignal<WorkspaceView>(emptyWorkspace)
  const [rolesSig, setRolesSig] = createSignal<RolesReadout>(roles)
  const [overlay, setOverlaySig] = createSignal<Overlay>({ kind: "none" })
  const [oauth, setOauthSig] = createSignal<Option.Option<OAuthSession>>(Option.none())
  const composerClear = { current: () => {} }
  const composerRead = { current: (): string => "" }
  const [busySince, setBusySince] = createSignal(0)
  const [lastEventAt, setLastEventAt] = createSignal(0)
  return {
    floor,
    reduce: (event) =>
      batch(() => {
        setLastEventAt(Date.now())
        setFloor((state) => reduceFloor(state, event))
        setRefine((state) => reduceRefine(state, event))
      }),
    mode: modeSig,
    setMode: (next) => setModeSig(next),
    refine,
    addUserLine: (text) => setRefine((state) => withUserLine(state, text)),
    busy,
    setBusy: (value) => {
      setBusySig(value)
      setBusySince(value ? Date.now() : 0)
      if (value) setLastEventAt(Date.now())
    },
    busySince,
    lastEventAt,
    registerComposerRead: (read) => {
      composerRead.current = read
    },
    composerText: () => composerRead.current(),
    spinner,
    tickSpinner: () => setSpinner((n) => n + 1),
    notice,
    setNotice,
    exitCode,
    setExitCode: (code) => setExitCodeSig(code),
    roles: rolesSig,
    setRoles: (next) => setRolesSig(next),
    overlay,
    setOverlay: (next) => setOverlaySig(next),
    closeOverlay: () => setOverlaySig({ kind: "none" }),
    oauth,
    setOauth: (session) => setOauthSig(session),
    registerComposerClear: (clear) => {
      composerClear.current = clear
    },
    clearComposer: () => composerClear.current(),
    workspace,
    setWorkspace: (view) => setWorkspaceSig(view),
    resetFloor: (task, maxAttempts) => setFloor(initialFloor(task, maxAttempts)),
    resetRefine: () => setRefine(initialRefine),
  }
}

/** The locked-spec summary line the forge mode pins under the header. */
export const specChip = (doc: Option.Option<SpecDoc>): string =>
  Option.match(doc, {
    onNone: () => "",
    onSome: (d) =>
      `spec ${d.slug} (${d.status}) · ${d.acceptance.length} criteria · ${d.checks.length} checks`,
  })
