import { createSignal, type Accessor } from "solid-js"
import type { Fiber } from "effect"
import type { ConversationId } from "@efferent/core"
import type { StatusState } from "../presentation/statusBar.js"

/** In-flight `:login` OAuth handle: PKCE verifier + callback-server stop + waiter. */
export interface OAuthSession {
  readonly verifier: string
  readonly stop: () => void
  readonly fiber: Fiber.RuntimeFiber<void, never>
}

/** A `:browse` listing row, so `:resume <#>` can resolve a numbered pick. */
export interface BrowseEntry {
  readonly id: string
  readonly createdAt: number
  readonly firstPrompt?: string
}

/**
 * Run-lifecycle state owned by the Effect side, NOT reactive — and now
 * **encapsulated behind typed methods** so nothing can scribble raw fields (the
 * old `store.run.x = y` grab-bag, mutated from ~20 sites). Three concerns:
 *
 *  - **session** — the active conversation id, the submitted-while-busy queue,
 *    and the last `:browse` listing. `newConversation(id)` is the atomic
 *    set-id-and-clear-queue used by resume / build / reset.
 *  - **Effect-owned handles** — the in-flight agent fiber (so Esc can interrupt)
 *    and the `:login` OAuth session. Never rendered; a fiber is an Effect concern.
 *  - **view latch** — the Ctrl-C 2×-to-quit arming time.
 */
export interface RunHandle {
  getConversationId(): ConversationId
  /** Switch to a new/resumed conversation: set the id AND clear the pending queue. */
  newConversation(id: ConversationId): void
  enqueue(text: string): void
  dequeue(): string | undefined
  getBrowseList(): ReadonlyArray<BrowseEntry>
  setBrowseList(list: ReadonlyArray<BrowseEntry>): void
  getFiber(): Fiber.RuntimeFiber<void, never> | undefined
  setFiber(fiber: Fiber.RuntimeFiber<void, never> | undefined): void
  getOAuth(): OAuthSession | undefined
  setOAuth(session: OAuthSession | undefined): void
  getCtrlCArmedAt(): number | undefined
  setCtrlCArmedAt(at: number | undefined): void
}

const createRunHandle = (conversationId: ConversationId): RunHandle => {
  let cid = conversationId
  let queue: string[] = []
  let fiber: Fiber.RuntimeFiber<void, never> | undefined
  let oauth: OAuthSession | undefined
  let browseList: ReadonlyArray<BrowseEntry> = []
  let ctrlCArmedAt: number | undefined

  return {
    getConversationId: () => cid,
    newConversation: (id) => {
      cid = id
      queue = []
    },
    enqueue: (text) => {
      queue.push(text)
    },
    dequeue: () => queue.shift(),
    getBrowseList: () => browseList,
    setBrowseList: (list) => {
      browseList = list
    },
    getFiber: () => fiber,
    setFiber: (f) => {
      fiber = f
    },
    getOAuth: () => oauth,
    setOAuth: (s) => {
      oauth = s
    },
    getCtrlCArmedAt: () => ctrlCArmedAt,
    setCtrlCArmedAt: (at) => {
      ctrlCArmedAt = at
    },
  }
}

/**
 * Session slice: the status-bar model, the busy flag + transient note, the
 * static footer, and the non-reactive `run` lifecycle handle.
 */
export interface SessionSlice {
  readonly status: Accessor<StatusState>
  readonly setStatus: (patch: Partial<StatusState>) => void
  readonly busy: Accessor<boolean>
  readonly setBusy: (b: boolean) => void
  readonly note: Accessor<string | undefined>
  readonly setNote: (n: string | undefined) => void
  readonly footer: Accessor<string>
  /** Non-reactive, Effect-owned run lifecycle, behind typed methods. */
  readonly run: RunHandle
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

  return {
    status,
    setStatus: (patch) => setStatusSig((s) => ({ ...s, ...patch })),
    busy,
    setBusy: (b) => setBusySig(b),
    note,
    setNote: (n) => setNoteSig(n),
    footer,
    run: createRunHandle(init.conversationId),
  }
}
