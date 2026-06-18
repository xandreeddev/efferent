import { createSignal, type Accessor } from "solid-js"
import type { Fiber } from "effect"
import type { ConfigScope, ConversationId } from "@xandreed/sdk-core"
import { idleAgentState, type AgentState } from "../presentation/agentState.js"
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
  /**
   * The config tier onboarding is writing to (`"global"` machine-wide or
   * `"local"` this folder), or `undefined` outside onboarding so writes fall
   * back to their own defaults (auth → global, settings → local). Set when the
   * onboarding scope step is answered; cleared when onboarding ends.
   */
  getConfigScope(): ConfigScope | undefined
  setConfigScope(scope: ConfigScope | undefined): void
}

const createRunHandle = (conversationId: ConversationId): RunHandle => {
  let cid = conversationId
  let queue: string[] = []
  let fiber: Fiber.RuntimeFiber<void, never> | undefined
  let oauth: OAuthSession | undefined
  let browseList: ReadonlyArray<BrowseEntry> = []
  let ctrlCArmedAt: number | undefined
  let configScope: ConfigScope | undefined

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
    getConfigScope: () => configScope,
    setConfigScope: (s) => {
      configScope = s
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
  /** The live agent state machine (header chrome + loading indicators). */
  readonly agentState: Accessor<AgentState>
  readonly setAgentState: (f: AgentState | ((s: AgentState) => AgentState)) => void
  readonly note: Accessor<string | undefined>
  readonly setNote: (n: string | undefined) => void
  /**
   * Transient feedback (theme switched · copied · queued · unknown command):
   * shows in the status-bar note slot and clears itself after a few seconds.
   * Ephemera never lands in the conversation rail — the rail is the permanent
   * record. A toast never clobbers a newer note (e.g. "working…"), and a
   * newer note simply replaces a live toast.
   */
  readonly toast: (text: string) => void
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
  const [agentState, setAgentStateSig] = createSignal<AgentState>(idleAgentState)
  const [note, setNoteSig] = createSignal<string | undefined>(undefined)
  const [footer] = createSignal(init.footer)

  return {
    status,
    setStatus: (patch) => setStatusSig((s) => ({ ...s, ...patch })),
    busy,
    setBusy: (b) => setBusySig(b),
    agentState,
    setAgentState: (f) => setAgentStateSig(typeof f === "function" ? f : () => f),
    note,
    setNote: (n) => setNoteSig(n),
    toast: (text) => {
      setNoteSig(text)
      setTimeout(() => {
        // Clear only if this toast is still showing — never a newer note.
        setNoteSig((cur) => (cur === text ? undefined : cur))
      }, 4000)
    },
    footer,
    run: createRunHandle(init.conversationId),
  }
}
