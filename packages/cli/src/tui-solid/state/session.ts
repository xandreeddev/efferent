import { createSignal, type Accessor } from "solid-js"
import type { Fiber } from "effect"
import type { ConversationId } from "@efferent/core"
import type { StatusState } from "../../tui/statusBar.js"

/**
 * Run-lifecycle state owned by the Effect side, NOT reactive: the active
 * conversation, the in-flight agent fiber (so Esc can interrupt), the queue of
 * messages submitted while busy, and the last `:browse` listing (so `:resume
 * <#>` resolves a numbered pick). Kept off the signal graph because a fiber
 * handle is an Effect concern, never something the view renders.
 */
export interface RunState {
  conversationId: ConversationId
  runningFiber?: Fiber.RuntimeFiber<void, never> | undefined
  queue: string[]
  turnStartedAt: number
  /** Last `:browse` result, so `:resume <#>` can resolve a numbered choice. */
  browseList: ReadonlyArray<{
    readonly id: string
    readonly createdAt: number
    readonly firstPrompt?: string
  }>
  /** In-flight `:login` OAuth: PKCE verifier + callback-server stop + waiter fiber. */
  oauthSession?:
    | { verifier: string; stop: () => void; fiber: Fiber.RuntimeFiber<void, never> }
    | undefined
  /** Epoch ms of the last Ctrl-C — a second within 2 s quits (2×-to-quit). */
  ctrlCArmedAt?: number | undefined
}

/**
 * Session slice: the status-bar model, the busy flag + transient note, the
 * static footer, and the non-reactive `run` lifecycle block.
 */
export interface SessionSlice {
  readonly status: Accessor<StatusState>
  readonly setStatus: (patch: Partial<StatusState>) => void
  readonly busy: Accessor<boolean>
  readonly setBusy: (b: boolean) => void
  readonly note: Accessor<string | undefined>
  readonly setNote: (n: string | undefined) => void
  readonly footer: Accessor<string>
  /** Non-reactive, Effect-owned run state. */
  readonly run: RunState
}

export interface SessionInit {
  readonly status: StatusState
  readonly conversationId: ConversationId
  readonly footer: string
}

export const createSessionSlice = (init: SessionInit): SessionSlice => {
  const [status, setStatusSig] = createSignal<StatusState>(init.status)
  const [busy, setBusySig] = createSignal(false)
  const [note, setNoteSig] = createSignal<string | undefined>(undefined)
  const [footer] = createSignal(init.footer)

  const run: RunState = {
    conversationId: init.conversationId,
    queue: [],
    turnStartedAt: 0,
    browseList: [],
  }

  return {
    status,
    setStatus: (patch) => setStatusSig((s) => ({ ...s, ...patch })),
    busy,
    setBusy: (b) => setBusySig(b),
    note,
    setNote: (n) => setNoteSig(n),
    footer,
    run,
  }
}
