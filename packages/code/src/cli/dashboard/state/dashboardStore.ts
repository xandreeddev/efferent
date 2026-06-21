import { createSignal, type Accessor, type Setter } from "solid-js"
import type { SessionSummary, WorkspaceMetrics } from "@xandreed/sdk-core"
import type { MessageLine } from "../presentation/dashboardView.js"

/**
 * The control dashboard's reactive state — small, k9s-shaped: live metrics, the
 * fleet/agent session list, the "messages flying" tail, and the cursor/fold over
 * the fleet tree. Fed by the runtime's pollers + the SSE firehose; read by the
 * `Dashboard` view. Far smaller than the coder's `createTuiStore` — the
 * dashboard is an operator console, not a conversation.
 */
const MAX_MESSAGES = 200

export interface DashboardStore {
  readonly metrics: Accessor<WorkspaceMetrics | undefined>
  readonly setMetrics: Setter<WorkspaceMetrics | undefined>
  readonly sessions: Accessor<ReadonlyArray<SessionSummary>>
  readonly setSessions: Setter<ReadonlyArray<SessionSummary>>
  readonly messages: Accessor<ReadonlyArray<MessageLine>>
  /** Append messages to the bounded tail (oldest dropped past the cap). */
  readonly pushMessages: (msgs: ReadonlyArray<MessageLine>) => void
  readonly cursor: Accessor<number>
  readonly setCursor: Setter<number>
  readonly collapsed: Accessor<ReadonlySet<string>>
  readonly setCollapsed: Setter<ReadonlySet<string>>
  /** A transient status line (last action / error / hint). */
  readonly note: Accessor<string | undefined>
  readonly setNote: Setter<string | undefined>
  /** True when the workspace has no provider credential (onboarding needed). */
  readonly needsLogin: Accessor<boolean>
  readonly setNeedsLogin: Setter<boolean>
}

export const createDashboardStore = (): DashboardStore => {
  const [metrics, setMetrics] = createSignal<WorkspaceMetrics | undefined>(undefined)
  const [sessions, setSessions] = createSignal<ReadonlyArray<SessionSummary>>([])
  const [messages, setMessages] = createSignal<ReadonlyArray<MessageLine>>([])
  const [cursor, setCursor] = createSignal(0)
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set())
  const [note, setNote] = createSignal<string | undefined>(undefined)
  const [needsLogin, setNeedsLogin] = createSignal(false)
  return {
    metrics,
    setMetrics,
    sessions,
    setSessions,
    messages,
    pushMessages: (msgs) =>
      setMessages((prev) => {
        const next = [...prev, ...msgs]
        return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next
      }),
    cursor,
    setCursor,
    collapsed,
    setCollapsed,
    note,
    setNote,
    needsLogin,
    setNeedsLogin,
  }
}
