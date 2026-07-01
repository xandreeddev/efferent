import { Deferred, Effect, Fiber, Ref } from "effect"
import type { AgentEvent } from "../entities/AgentEvent.js"

/**
 * The in-memory agent **comms + supervision bus** — the spine of the async
 * fleet. The whole fleet is fibers in one runtime (no IPC), so the bus is plain
 * Effect state over a `Ref`; what it carries is everything the fleet needs to
 * run like a team of people rather than a blocking call tree:
 *
 *  - **Mailboxes** — a per-agent inbox keyed by its context-node id (the root
 *    conversation uses its own id as a key). `send_message`, a human pairing in
 *    a preview, and a child's completion all `post` here; the recipient drains
 *    it at its next turn boundary (the loop's `onTransformContext` hook) and
 *    folds the messages into context. A post also fulfils the recipient's
 *    **wake** latch, so an agent parked in `wait_for_agents` returns at once
 *    instead of sleeping out its timeout — you can always reach a busy agent.
 *  - **Blackboard** — a shared scratchpad every agent `post`s/`read`s, so
 *    parallel siblings see each other's findings without direct addressing.
 *  - **Supervision** — each running agent registers its **fiber** (so `:stop`
 *    and teardown can interrupt it) and a **completion** `Deferred` (so a parent
 *    can await it without polling). When it finishes the bus keeps a small
 *    terminal **result** record (status + summary + files) so a gather can read
 *    a just-finished agent's outcome even after its mailbox is gone.
 *
 * Nothing blocks structurally: spawning forks a fiber and returns immediately;
 * gathering (`awaitChange`) races completions against the waiter's own inbox and
 * a timeout, all interruptible. The durable record stays the context tree; this
 * is the live layer the TUI and the agents tap to see who's running and say
 * what to whom.
 *
 * This is the core **Supervisor** — the orchestration substrate, owned by
 * `@xandreed/sdk-core` (not the CLI driver). It is threaded as a constructed
 * value rather than resolved from a `Context.Tag` port on purpose: it is
 * per-session stateful and carries a per-runtime event sink (`onBusEvent`), so
 * each driver builds its own with {@link makeAgentBus}; a process-singleton
 * Layer would fight that. {@link Supervisor} is the name the rest of the system
 * uses for this capability.
 */

/** The core orchestration service (see the module doc). Structurally the {@link AgentBus}. */
export type Supervisor = AgentBus

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

/** Live status of an agent the bus knows about. */
export type AgentRunStatus = "running" | "ok" | "error"

/** The terminal outcome of a finished run — what a gather reports to a parent. */
export interface AgentResultRecord {
  readonly status: "ok" | "error"
  readonly summary: string
  readonly filesChanged: ReadonlyArray<string>
}

/** A point-in-time view of one agent for a status query / gather. */
export interface AgentSnapshot {
  readonly nodeId: string
  readonly label: string
  readonly status: AgentRunStatus
  readonly summary?: string
  readonly filesChanged?: ReadonlyArray<string>
}

/** Options for registering a running agent. */
export interface MarkRunningOpts {
  /** The bus key of the agent (or root) that spawned this one — its completion
   *  message is delivered there, and `childrenOf(parentKey)` finds it. */
  readonly parentKey?: string | null
}

export interface AgentBus {
  /**
   * Register (or re-affirm) a live mailbox + completion latch for a running
   * agent. Idempotent: a second call keeps the existing completion `Deferred`
   * (so a parent that already grabbed it still gets fulfilled), only refreshing
   * the label/parent. The handler pre-registers a child before forking so a
   * sibling can address it the instant `run_agent` returns its id.
   */
  readonly markRunning: (
    nodeId: string,
    label: string,
    opts?: MarkRunningOpts,
  ) => Effect.Effect<void>
  /** Record the agent's running fiber, so `:stop` / teardown can interrupt it. */
  readonly setFiber: (
    nodeId: string,
    fiber: Fiber.RuntimeFiber<unknown, unknown>,
  ) => Effect.Effect<void>
  /**
   * Close a run with its outcome: keep a terminal result record, fulfil the
   * completion latch (waiters wake), deliver a completion message to the parent's
   * inbox + the blackboard, then tear the mailbox down. The single "this agent
   * finished" path.
   */
  readonly complete: (
    nodeId: string,
    result: AgentResultRecord,
  ) => Effect.Effect<void>
  /** Tear down a mailbox with no result (interrupt path); fulfils the latch so a
   *  parent waiting on it never hangs. */
  readonly markDone: (nodeId: string) => Effect.Effect<void>
  readonly isRunning: (nodeId: string) => Effect.Effect<boolean>
  /** Running agents with mailboxes, for addressing + the cockpit. */
  readonly listRunning: () => Effect.Effect<ReadonlyArray<{ nodeId: string; label: string }>>
  /** Node ids of the agents `parentKey` spawned — running AND recently finished —
   *  so a gather's "watch everything I spawned" default still reports a child that
   *  completed before the parent looked. For "is the fleet still working?" use
   *  {@link runningChildrenOf}, not this. */
  readonly childrenOf: (parentKey: string) => Effect.Effect<ReadonlyArray<string>>
  /** Node ids of the agents `parentKey` spawned that are STILL RUNNING — for
   *  fleet-idle detection (`length === 0` ⇒ idle) and a fleet-scoped interrupt; a
   *  finished child needs neither and must not keep these sets non-empty forever. */
  readonly runningChildrenOf: (parentKey: string) => Effect.Effect<ReadonlyArray<string>>
  /** Interrupt one running agent's fiber. False when it isn't running / has no fiber. */
  readonly interrupt: (nodeId: string) => Effect.Effect<boolean>
  /** Interrupt ONE fleet's running subtree — every running descendant of
   *  `parentKey` (BFS over the parent links), never the rest of the bus. This is
   *  the scoped kill for Esc / a headless deadline / a parent stopping its own
   *  fleet; `interruptAll` stays reserved for process shutdown. */
  readonly interruptSubtree: (parentKey: string) => Effect.Effect<void>
  /** Interrupt every running agent (process teardown ONLY — no orphans). A
   *  user-facing cancel must use {@link interruptSubtree}: this kills every
   *  fleet on the bus, including ones the canceller doesn't own. */
  readonly interruptAll: () => Effect.Effect<void>
  /** Post to an agent's inbox + wake it. Returns false when the target isn't running. */
  readonly post: (nodeId: string, msg: InboxMessage) => Effect.Effect<boolean>
  /** Take + clear a mailbox (the recipient drains it at a turn boundary). */
  readonly drain: (nodeId: string) => Effect.Effect<ReadonlyArray<InboxMessage>>
  readonly boardPost: (note: BoardNote) => Effect.Effect<void>
  readonly boardRead: () => Effect.Effect<ReadonlyArray<BoardNote>>
  /** A status view of the given agents (or all known, running + recently done). */
  readonly snapshot: (
    nodeIds?: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<AgentSnapshot>>
  /**
   * Block (interruptibly) until something the waiter cares about happens: any
   * watched agent finishes, a message lands in the waiter's own inbox, or the
   * timeout elapses — whichever first. Returns immediately if a watched agent is
   * already finished or the waiter already has mail. The non-blocking gather
   * primitive behind `wait_for_agents`.
   */
  readonly awaitChange: (opts: {
    readonly waiterKey: string
    readonly watch: ReadonlyArray<string>
    readonly timeoutMs: number
  }) => Effect.Effect<void>
}

interface AgentEntry {
  readonly label: string
  readonly parentKey: string | null
  readonly inbox: ReadonlyArray<InboxMessage>
  /** Fulfilled exactly once when the run finishes (complete/markDone). */
  readonly completion: Deferred.Deferred<void>
  /** Set while the agent is parked in awaitChange; a post fulfils it to wake it. */
  readonly wake: Deferred.Deferred<void> | undefined
  readonly fiber: Fiber.RuntimeFiber<unknown, unknown> | undefined
}

interface DoneEntry {
  readonly label: string
  readonly parentKey: string | null
  readonly status: "ok" | "error"
  readonly summary: string
  readonly filesChanged: ReadonlyArray<string>
}

interface BusState {
  readonly running: ReadonlyMap<string, AgentEntry>
  readonly done: ReadonlyMap<string, DoneEntry>
  readonly board: ReadonlyArray<BoardNote>
  /**
   * Completion notes for a parent that ISN'T currently running — keyed by the
   * parent's bus key. A root that delegates and then ENDS its turn has no live
   * mailbox when its lead later finishes, so the completion is buffered here and
   * merged into the parent's inbox the next time it registers a mailbox
   * (`markRunning`, including the auto-resume). Without this, an auto-resumed
   * orchestrator drains an empty inbox and reports nothing ("no ping back").
   */
  readonly pending: ReadonlyMap<string, ReadonlyArray<InboxMessage>>
}

/** Keep the blackboard bounded — oldest notes fall off (the agent re-reads). */
const MAX_BOARD = 200
/** Keep recently-finished results bounded — a gather reads them, then they age out. */
const MAX_DONE = 200
/** Cap buffered completions per idle parent (a parent that never resumes). */
const MAX_PENDING = 100

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

/** A short, stable label for an agent in a completion/board message. */
const shortKey = (nodeId: string): string => nodeId.slice(0, 8)

/**
 * Synchronous constructor so `buildScopeRuntime` can build one without being an
 * Effect; the methods are Effects over the Ref.
 */
export const makeAgentBus = (
  /** Optional sink: every inter-agent message (board post, inbox message,
   *  completion note) is also emitted as a `board_note` `AgentEvent` so the
   *  daemon's event ledger carries the "messages flying" stream. */
  onEvent?: (event: AgentEvent) => Effect.Effect<void>,
): AgentBus => {
  const ref = Ref.unsafeMake<BusState>({
    running: new Map(),
    done: new Map(),
    board: [],
    pending: new Map(),
  })
  const emit = (from: string, note: string, at: number): Effect.Effect<void> =>
    onEvent !== undefined ? onEvent({ type: "board_note", from, note, at }) : Effect.void

  const snapshotOne = (s: BusState, nodeId: string): AgentSnapshot => {
    const run = s.running.get(nodeId)
    if (run !== undefined) return { nodeId, label: run.label, status: "running" }
    const fin = s.done.get(nodeId)
    if (fin !== undefined) {
      return {
        nodeId,
        label: fin.label,
        status: fin.status,
        summary: fin.summary,
        filesChanged: fin.filesChanged,
      }
    }
    return { nodeId, label: shortKey(nodeId), status: "running" }
  }

  return {
    markRunning: (nodeId, label, opts) =>
      Effect.gen(function* () {
        const completion = yield* Deferred.make<void>()
        yield* Ref.update(ref, (s) => {
          const existing = s.running.get(nodeId)
          // Merge any completions buffered while this agent was idle (a child
          // that finished after the parent ended its turn), so the resuming
          // turn's inbox-draining hook actually sees them.
          const buffered = s.pending.get(nodeId) ?? []
          const running = new Map(s.running)
          running.set(nodeId, {
            label,
            parentKey: opts?.parentKey ?? existing?.parentKey ?? null,
            inbox: [...(existing?.inbox ?? []), ...buffered],
            // Keep an existing completion latch so a parent that already awaits
            // it is still woken; only the first registration creates one.
            completion: existing?.completion ?? completion,
            wake: existing?.wake,
            fiber: existing?.fiber,
          })
          if (buffered.length === 0) return { ...s, running }
          const pending = new Map(s.pending)
          pending.delete(nodeId)
          return { ...s, running, pending }
        })
      }),

    setFiber: (nodeId, fiber) =>
      Ref.update(ref, (s) => {
        const e = s.running.get(nodeId)
        if (e === undefined) return s
        const running = new Map(s.running)
        running.set(nodeId, { ...e, fiber })
        return { ...s, running }
      }),

    complete: (nodeId, result) =>
      Effect.gen(function* () {
        const entry = yield* Ref.modify(ref, (s) => {
          const e = s.running.get(nodeId)
          const running = new Map(s.running)
          running.delete(nodeId)
          const done = new Map(s.done)
          done.set(nodeId, {
            label: e?.label ?? shortKey(nodeId),
            parentKey: e?.parentKey ?? null,
            status: result.status,
            summary: result.summary,
            filesChanged: result.filesChanged,
          })
          // Bound the done map — drop the oldest insertions.
          while (done.size > MAX_DONE) {
            const oldest = done.keys().next().value
            if (oldest === undefined) break
            done.delete(oldest)
          }
          return [e, { ...s, running, done }]
        })
        if (entry === undefined) return
        // Wake anyone awaiting this run (parent gather) and its own park latch.
        yield* Deferred.succeed(entry.completion, undefined).pipe(Effect.ignore)
        if (entry.wake !== undefined) {
          yield* Deferred.succeed(entry.wake, undefined).pipe(Effect.ignore)
        }
        // Deliver the outcome to the parent's inbox + the blackboard, so a parent
        // not actively waiting still picks it up at its next turn, and siblings
        // see it on the board. Best-effort: a finished/absent parent just drops it.
        const line = `${result.status === "ok" ? "finished" : "failed"}: ${clip(result.summary, 600)}`
        if (entry.parentKey !== null && entry.parentKey.length > 0) {
          const at = Date.now()
          const msg = { from: `agent ${shortKey(nodeId)} (${entry.label})`, content: line, at }
          yield* Ref.update(ref, (s) => {
            const p = s.running.get(entry.parentKey as string)
            if (p !== undefined) {
              // Parent is live — straight into its inbox (folded at its next turn
              // boundary, or read by a `wait_for_agents` gather).
              const running = new Map(s.running)
              running.set(entry.parentKey as string, { ...p, inbox: [...p.inbox, msg] })
              return { ...s, running }
            }
            // Parent is idle (it delegated then ended its turn) — buffer the
            // completion so its next mailbox registration (the auto-resume) picks
            // it up, instead of dropping it on the floor.
            const cur = s.pending.get(entry.parentKey as string) ?? []
            const pending = new Map(s.pending)
            pending.set(entry.parentKey as string, [...cur, msg].slice(-MAX_PENDING))
            return { ...s, pending }
          })
          // Wake a parent parked in awaitChange.
          const parent = yield* Ref.get(ref).pipe(
            Effect.map((s) => s.running.get(entry.parentKey as string)),
          )
          if (parent?.wake !== undefined) {
            yield* Deferred.succeed(parent.wake, undefined).pipe(Effect.ignore)
          }
        }
        const at = Date.now()
        yield* Ref.update(ref, (s) => ({
          ...s,
          board: [...s.board, { from: entry.label, note: line, at }].slice(-MAX_BOARD),
        }))
        yield* emit(entry.label, line, at)
      }),

    markDone: (nodeId) =>
      Effect.gen(function* () {
        const entry = yield* Ref.modify(ref, (s) => {
          const e = s.running.get(nodeId)
          if (e === undefined) return [undefined, s]
          const running = new Map(s.running)
          running.delete(nodeId)
          return [e, { ...s, running }]
        })
        if (entry === undefined) return
        yield* Deferred.succeed(entry.completion, undefined).pipe(Effect.ignore)
        if (entry.wake !== undefined) {
          yield* Deferred.succeed(entry.wake, undefined).pipe(Effect.ignore)
        }
      }),

    isRunning: (nodeId) => Ref.get(ref).pipe(Effect.map((s) => s.running.has(nodeId))),

    listRunning: () =>
      Ref.get(ref).pipe(
        Effect.map((s) =>
          [...s.running.entries()].map(([nodeId, e]) => ({ nodeId, label: e.label })),
        ),
      ),

    childrenOf: (parentKey) =>
      Ref.get(ref).pipe(
        Effect.map((s) => {
          const running = [...s.running.entries()]
            .filter(([, e]) => e.parentKey === parentKey)
            .map(([nodeId]) => nodeId)
          // Finished children too, so a gather's "watch all I spawned" default
          // still reports an agent that completed before the parent looked.
          const done = [...s.done.entries()]
            .filter(([, e]) => e.parentKey === parentKey)
            .map(([nodeId]) => nodeId)
          return [...new Set([...running, ...done])]
        }),
      ),

    runningChildrenOf: (parentKey) =>
      Ref.get(ref).pipe(
        Effect.map((s) =>
          [...s.running.entries()]
            .filter(([, e]) => e.parentKey === parentKey)
            .map(([nodeId]) => nodeId),
        ),
      ),

    interrupt: (nodeId) =>
      Effect.gen(function* () {
        const fiber = yield* Ref.get(ref).pipe(
          Effect.map((s) => s.running.get(nodeId)?.fiber),
        )
        if (fiber === undefined) return false
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        return true
      }),

    interruptSubtree: (parentKey) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(ref)
        // BFS over the running entries' parent links from `parentKey` — a
        // snapshot walk (a child spawned mid-interrupt is orphan-proofed by its
        // parent's interruption landing before the next spawn can register).
        const byParent = new Map<string, Array<{ nodeId: string; fiber: Fiber.RuntimeFiber<unknown, unknown> | undefined }>>()
        for (const [nodeId, e] of s.running.entries()) {
          if (e.parentKey === null) continue
          const arr = byParent.get(e.parentKey) ?? []
          arr.push({ nodeId, fiber: e.fiber })
          byParent.set(e.parentKey, arr)
        }
        const seen = new Set<string>()
        const fibers: Array<Fiber.RuntimeFiber<unknown, unknown>> = []
        let frontier = [parentKey]
        while (frontier.length > 0) {
          const next: string[] = []
          for (const key of frontier) {
            for (const child of byParent.get(key) ?? []) {
              if (seen.has(child.nodeId)) continue
              seen.add(child.nodeId)
              next.push(child.nodeId)
              if (child.fiber !== undefined) fibers.push(child.fiber)
            }
          }
          frontier = next
        }
        yield* Effect.forEach(fibers, (f) => Fiber.interrupt(f).pipe(Effect.ignore), {
          discard: true,
        })
      }),

    interruptAll: () =>
      Effect.gen(function* () {
        const fibers = yield* Ref.get(ref).pipe(
          Effect.map((s) =>
            [...s.running.values()]
              .map((e) => e.fiber)
              .filter((f): f is Fiber.RuntimeFiber<unknown, unknown> => f !== undefined),
          ),
        )
        yield* Effect.forEach(fibers, (f) => Fiber.interrupt(f).pipe(Effect.ignore), {
          discard: true,
        })
      }),

    post: (nodeId, msg) =>
      Effect.gen(function* () {
        const entry = yield* Ref.modify(ref, (s) => {
          const e = s.running.get(nodeId)
          if (e === undefined) return [undefined, s]
          const running = new Map(s.running)
          running.set(nodeId, { ...e, inbox: [...e.inbox, msg] })
          return [e, { ...s, running }]
        })
        if (entry === undefined) return false
        if (entry.wake !== undefined) {
          yield* Deferred.succeed(entry.wake, undefined).pipe(Effect.ignore)
        }
        yield* emit(msg.from, msg.content, msg.at)
        return true
      }),

    drain: (nodeId) =>
      Ref.modify(ref, (s) => {
        const e = s.running.get(nodeId)
        if (e === undefined || e.inbox.length === 0) return [[], s]
        const running = new Map(s.running)
        running.set(nodeId, { ...e, inbox: [] })
        return [e.inbox, { ...s, running }]
      }),

    boardPost: (note) =>
      Ref.update(ref, (s) => ({ ...s, board: [...s.board, note].slice(-MAX_BOARD) })).pipe(
        Effect.zipRight(emit(note.from, note.note, note.at)),
      ),

    boardRead: () => Ref.get(ref).pipe(Effect.map((s) => s.board)),

    snapshot: (nodeIds) =>
      Ref.get(ref).pipe(
        Effect.map((s) => {
          const ids =
            nodeIds !== undefined && nodeIds.length > 0
              ? nodeIds
              : [...new Set([...s.running.keys(), ...s.done.keys()])]
          return ids.map((id) => snapshotOne(s, id))
        }),
      ),

    awaitChange: ({ waiterKey, watch, timeoutMs }) =>
      Effect.gen(function* () {
        const s0 = yield* Ref.get(ref)
        // Block on the *transition* of a still-running watched agent to done —
        // NOT on the done *level*. The old `watch.some(statusOf !== "running")`
        // was a level check: once any watched child had finished it stayed true
        // forever, so every later gather returned in ~1s (a busy-spin), and a
        // forced orchestrator "resolved" the early return by spawning more
        // agents. A finished child instead lands a completion message in the
        // waiter's inbox (see `complete`) — caught by `haveMail` below.
        const running = watch.filter((id) => s0.running.has(id))
        const haveMail = (s0.running.get(waiterKey)?.inbox.length ?? 0) > 0
        // Return now if there's mail to report, or every watched agent is
        // already done (nothing left to wait for). With NO watched agents at
        // all, fall through and park — a `post` can still wake us (reach a busy
        // agent / a human steer), bounded by the timeout.
        const allWatchedDone = watch.length > 0 && running.length === 0
        if (haveMail || allWatchedDone) return

        // Park: set the waiter's wake latch, race it against the watched
        // completions and a timeout, then clear the latch on every exit path.
        const wake = yield* Deferred.make<void>()
        yield* Ref.update(ref, (s) => {
          const e = s.running.get(waiterKey)
          if (e === undefined) return s
          const running = new Map(s.running)
          running.set(waiterKey, { ...e, wake })
          return { ...s, running }
        })
        const clearWake = Ref.update(ref, (s) => {
          const e = s.running.get(waiterKey)
          if (e === undefined || e.wake !== wake) return s
          const running = new Map(s.running)
          running.set(waiterKey, { ...e, wake: undefined })
          return { ...s, running }
        })
        const completions = running
          .map((id) => s0.running.get(id)?.completion)
          .filter((d): d is Deferred.Deferred<void> => d !== undefined)
          .map((d) => Deferred.await(d))
        yield* Effect.raceAll([
          Deferred.await(wake),
          Effect.sleep(`${Math.max(0, timeoutMs)} millis`),
          ...completions,
        ]).pipe(Effect.ensuring(clearWake))
      }),
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
