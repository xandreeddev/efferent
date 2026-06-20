import { Effect, Ref } from "effect"

/**
 * Phase 3 — the in-memory agent comms bus. Two channels, both Effect `Ref`s
 * (no IPC; the whole fleet is fibers in one runtime — see the execution model):
 *
 *  - **Mailboxes** — a per-agent inbox keyed by context-node id. `send_message`
 *    posts to one; the recipient's loop drains it at its next turn boundary (a
 *    driver `onTransformContext` hook) and folds the messages into context. A
 *    mailbox exists only while its agent is RUNNING, so a message to a finished
 *    agent fails fast (its result is already in `:tree`).
 *  - **Blackboard** — a shared scratchpad every agent can `post`/`read`, so
 *    parallel siblings see each other's findings without direct addressing.
 *
 * Persistence is deliberately out of scope for v1 (a turn's subtree is
 * ephemeral); the durable record stays the context tree. Bounded only by the
 * shared token budget + a blackboard cap — a strict ping-pong cap is deferred.
 */

export interface InboxMessage {
  /** Display label of the sender (a sibling agent, or "you" for the human). */
  readonly from: string
  readonly content: string
  readonly at: number
}

export interface BoardNote {
  readonly from: string
  readonly note: string
  readonly at: number
}

export interface AgentBus {
  /** Register a live mailbox for a running agent (called as its run starts). */
  readonly markRunning: (nodeId: string, label: string) => Effect.Effect<void>
  /** Tear down the mailbox when the run ends (delivered-but-unread are dropped). */
  readonly markDone: (nodeId: string) => Effect.Effect<void>
  readonly isRunning: (nodeId: string) => Effect.Effect<boolean>
  /** Running agents with mailboxes, for addressing + the cockpit. */
  readonly listRunning: () => Effect.Effect<ReadonlyArray<{ nodeId: string; label: string }>>
  /** Post to an agent's inbox. Returns false when the target isn't running. */
  readonly post: (nodeId: string, msg: InboxMessage) => Effect.Effect<boolean>
  /** Take + clear a mailbox (the recipient drains it at a turn boundary). */
  readonly drain: (nodeId: string) => Effect.Effect<ReadonlyArray<InboxMessage>>
  readonly boardPost: (note: BoardNote) => Effect.Effect<void>
  readonly boardRead: () => Effect.Effect<ReadonlyArray<BoardNote>>
}

interface BusState {
  readonly mailboxes: ReadonlyMap<string, ReadonlyArray<InboxMessage>>
  readonly running: ReadonlyMap<string, string>
  readonly board: ReadonlyArray<BoardNote>
}

/** Keep the blackboard bounded — oldest notes fall off (the agent re-reads). */
const MAX_BOARD = 200

/**
 * Synchronous constructor (mirrors `makeFolderLocks`) so `buildScopeRuntime`
 * can build one without being an Effect; the methods are Effects over the Ref.
 */
export const makeAgentBus = (): AgentBus => {
  const ref = Ref.unsafeMake<BusState>({
    mailboxes: new Map(),
    running: new Map(),
    board: [],
  })
  return {
    markRunning: (nodeId, label) =>
      Ref.update(ref, (s) => ({ ...s, running: new Map(s.running).set(nodeId, label) })),
    markDone: (nodeId) =>
      Ref.update(ref, (s) => {
        const running = new Map(s.running)
        running.delete(nodeId)
        const mailboxes = new Map(s.mailboxes)
        mailboxes.delete(nodeId)
        return { ...s, running, mailboxes }
      }),
    isRunning: (nodeId) => Ref.get(ref).pipe(Effect.map((s) => s.running.has(nodeId))),
    listRunning: () =>
      Ref.get(ref).pipe(
        Effect.map((s) => [...s.running.entries()].map(([nodeId, label]) => ({ nodeId, label }))),
      ),
    post: (nodeId, msg) =>
      Ref.modify(ref, (s) => {
        if (!s.running.has(nodeId)) return [false, s]
        const prev = s.mailboxes.get(nodeId) ?? []
        const mailboxes = new Map(s.mailboxes).set(nodeId, [...prev, msg])
        return [true, { ...s, mailboxes }]
      }),
    drain: (nodeId) =>
      Ref.modify(ref, (s) => {
        const msgs = s.mailboxes.get(nodeId) ?? []
        if (msgs.length === 0) return [msgs, s]
        const mailboxes = new Map(s.mailboxes)
        mailboxes.delete(nodeId)
        return [msgs, { ...s, mailboxes }]
      }),
    boardPost: (note) =>
      Ref.update(ref, (s) => ({ ...s, board: [...s.board, note].slice(-MAX_BOARD) })),
    boardRead: () => Ref.get(ref).pipe(Effect.map((s) => s.board)),
  }
}

/** Render drained inbox messages as synthetic user turns for the recipient's
 *  context — clearly attributed so the model treats them as inbound, not its
 *  own. Used by the driver's `onTransformContext` inbox-drain hook. */
export const inboxToMessages = (
  msgs: ReadonlyArray<InboxMessage>,
): ReadonlyArray<{ readonly role: "user"; readonly content: string }> =>
  msgs.map((m) => ({
    role: "user" as const,
    content: `[inbox · message from ${m.from}]\n${m.content}`,
  }))
