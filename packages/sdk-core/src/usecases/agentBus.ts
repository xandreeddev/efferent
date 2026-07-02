import { Deferred, Effect, Exit, Fiber, Ref, Scope } from "effect"
import type { AgentEvent } from "../entities/AgentEvent.js"

/** WHO killed a run — stamped on the entry when an interrupt API fires, read by
 *  the exit finalizer so the persisted StopReason says `interrupt(by: …)`
 *  instead of guessing. Mirrors `StopReason`'s interrupt `by` in Outcome.ts. */
export type InterruptBy = "human" | "parent" | "shutdown" | "deadline"

/**
 * What a running agent is DOING right now — the health state behind the
 * watchdog, the fleet tree's live suffix, and `wait_for_agents`' per-agent
 * detail. The watchdog kills only a zero-activity `starting`/`generating` run
 * (a hung model call — the original silent-stall class); every other state is
 * bounded elsewhere (tools by their own timeouts, retries by the retry cap,
 * waits by the gather timeout, approval by the human who owns it) and must
 * never be killed as "stalled".
 */
export type RunState =
  | "starting"
  | "generating"
  | "tool-running"
  | "retrying"
  | "awaiting-approval"
  | "waiting-on-agents"

export interface RunHealth {
  readonly state: RunState
  /** Epoch ms of the last observable signal (turn start / tool boundary /
   *  narration / retry notice). Staleness is computed by readers. */
  readonly lastActivityAt: number
  /** Short human line: the running tool's name, `429 2/3 — next in 8s`, … */
  readonly detail?: string
  /** Billed tokens so far (input+output), when known. */
  readonly tokens?: number
}

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
 *    and a subtree kill can interrupt it), a **completion** `Deferred` (so a
 *    parent can await it without polling), and its live **health** (state +
 *    last-activity — the watchdog's and the UI's shared truth). Spawned runs
 *    are forked into the bus's fleet scope (`forkSupervised`); `shutdown`
 *    interrupts + awaits them all. Finished-run RECORDS live in the durable
 *    context tree, not here — the bus carries only live state.
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

/** Live status of an agent the bus knows about — `running` plus the honest
 *  terminal vocabulary (see `entities/Outcome.ts`). */
export type AgentRunStatus = "running" | "ok" | "partial" | "error" | "killed"

/** The terminal outcome of a finished run — what a gather reports to a parent.
 *  `partial` = a usable deliverable that stopped early (budget / step-cap /
 *  stall-after-text); `killed` = interrupted / stalled with nothing produced. */
export interface AgentResultRecord {
  readonly status: "ok" | "partial" | "error" | "killed"
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
  /** Live health, for RUNNING entries only (what it's doing + last activity). */
  readonly health?: RunHealth
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
  /** Interrupt one running agent's fiber. False when it isn't running / has no
   *  fiber. `by` (default `"parent"`) stamps WHO killed it for the finalizer. */
  readonly interrupt: (nodeId: string, by?: InterruptBy) => Effect.Effect<boolean>
  /** Interrupt ONE fleet's running subtree — every running descendant of
   *  `parentKey` (BFS over the parent links), never the rest of the bus. This is
   *  the scoped kill for Esc / a headless deadline / a parent stopping its own
   *  fleet; `interruptAll` stays reserved for process shutdown. */
  readonly interruptSubtree: (parentKey: string, by?: InterruptBy) => Effect.Effect<void>
  /** Interrupt every running agent (process teardown ONLY — no orphans). A
   *  user-facing cancel must use {@link interruptSubtree}: this kills every
   *  fleet on the bus, including ones the canceller doesn't own. */
  readonly interruptAll: (by?: InterruptBy) => Effect.Effect<void>
  /** WHO interrupted this run, if an interrupt API stamped it — read by the exit
   *  finalizer (the entry is still registered at that point). */
  readonly interruptReasonOf: (
    nodeId: string,
  ) => Effect.Effect<InterruptBy | undefined>
  /**
   * Stamp a running agent's live health (state transition and/or activity).
   * Edge-triggered `agent_health` events ride the bus sink: one on every state
   * CHANGE, plus a re-stamp when `lastActivityAt` jumps a bucket — never a
   * heartbeat stream. No-op for an unregistered id.
   */
  readonly setHealth: (
    nodeId: string,
    patch: {
      readonly state?: RunState
      readonly detail?: string
      readonly at: number
      readonly tokens?: number
    },
  ) => Effect.Effect<void>
  /** The live health of a RUNNING agent (undefined once finished/unknown). */
  readonly healthOf: (nodeId: string) => Effect.Effect<RunHealth | undefined>
  /**
   * Fork a spawned run as a SUPERVISED fiber in the bus's fleet scope — the
   * replacement for the old `forkDaemon(...catchAll(() => void))`, whose exits
   * were discarded and whose fibers outlived teardown (stranding DB rows
   * `running` forever on process exit). Supervised fibers are interrupted AND
   * AWAITED by {@link shutdown}, so every run's exit finalizer gets to record
   * an honest `killed(shutdown)` before the process quits.
   */
  readonly forkSupervised: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Fiber.RuntimeFiber<A, E>, never, R>
  /**
   * Process-teardown: stamp every running entry `interruptedBy: "shutdown"`,
   * then close the fleet scope — interrupting every supervised fiber and
   * WAITING for each one's finalizer to record its terminal return. The one
   * sanctioned "kill everything" (drivers' exit finalizers); a user-facing
   * cancel uses {@link interruptSubtree}.
   */
  readonly shutdown: () => Effect.Effect<void>
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
  /** WHO interrupted this run (stamped by the interrupt APIs, read by finalize). */
  readonly interruptedBy: InterruptBy | undefined
  /** Live health (what it's doing + last activity) — see {@link RunHealth}. */
  readonly health: RunHealth | undefined
  /** When an `agent_health` event last rode the sink (edge-trigger bookkeeping). */
  readonly healthEmittedAt: number | undefined
}

interface BusState {
  readonly running: ReadonlyMap<string, AgentEntry>
  readonly board: ReadonlyArray<BoardNote>
  /**
   * Completion notes for a parent that ISN'T currently running — keyed by the
   * parent's bus key. A root that delegates and then ENDS its turn has no live
   * mailbox when its lead later finishes, so the completion is buffered here and
   * merged into the parent's inbox the next time it registers a mailbox
   * (`markRunning`, including the auto-resume). Without this, an auto-resumed
   * orchestrator drains an empty inbox and reports nothing ("no ping back").
   *
   * (There is NO `done` map any more: finished-run records live in the DURABLE
   * store — the context tree — which never ages out. The old bounded map's
   * aging made `wait_for_agents` synthesize finished children as
   * phantom-`running`, so a big fleet's gather could spin forever.)
   */
  readonly pending: ReadonlyMap<string, ReadonlyArray<InboxMessage>>
}

/** Keep the blackboard bounded — oldest notes fall off (the agent re-reads). */
const MAX_BOARD = 200
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
    board: [],
    pending: new Map(),
  })
  // The fleet scope every spawned run is forked into (`forkSupervised`) — the
  // bus IS the supervisor, so it owns the fibers' lifetime: `shutdown` closes
  // this scope, which interrupts AND awaits each supervised fiber (their exit
  // finalizers record honest terminal returns before the process exits).
  const fleetScope = Effect.runSync(Scope.make())
  const emit = (
    from: string,
    note: string,
    at: number,
    to?: string,
  ): Effect.Effect<void> =>
    onEvent !== undefined
      ? onEvent({
          type: "board_note",
          from,
          note,
          at,
          ...(to !== undefined ? { to } : {}),
        })
      : Effect.void

  // LIVE entries only — a finished/unknown id yields nothing (its terminal
  // record lives in the durable store; the old phantom-`running` fallback here
  // is what made aged-out children look alive forever).
  const snapshotOne = (s: BusState, nodeId: string): AgentSnapshot | undefined => {
    const run = s.running.get(nodeId)
    if (run === undefined) return undefined
    return {
      nodeId,
      label: run.label,
      status: "running",
      ...(run.health !== undefined ? { health: run.health } : {}),
    }
  }

  /** Stamp `interruptedBy` on the given running entries (first stamp wins) and
   *  return their fibers — one atomic step so the finalizer always sees the
   *  reason before the interrupt lands. */
  const stampInterrupted = (
    nodeIds: ReadonlyArray<string>,
    by: InterruptBy,
  ): Effect.Effect<ReadonlyArray<Fiber.RuntimeFiber<unknown, unknown>>> =>
    Ref.modify(ref, (s) => {
      const running = new Map(s.running)
      const fibers: Array<Fiber.RuntimeFiber<unknown, unknown>> = []
      for (const id of nodeIds) {
        const e = running.get(id)
        if (e === undefined) continue
        running.set(id, { ...e, interruptedBy: e.interruptedBy ?? by })
        if (e.fiber !== undefined) fibers.push(e.fiber)
      }
      return [fibers, { ...s, running }]
    })

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
            interruptedBy: existing?.interruptedBy,
            health:
              existing?.health ?? { state: "starting", lastActivityAt: Date.now() },
            healthEmittedAt: existing?.healthEmittedAt,
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
          // No done-record kept here: the terminal outcome is already durable
          // in the context tree (recordReturn precedes complete on the one
          // terminal path); the bus only wakes + delivers.
          return [e, { ...s, running }]
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
        // The label carries the honest status — a partial result must read as
        // usable-but-incomplete, never as plain "finished" or "failed".
        const verb =
          result.status === "ok"
            ? "finished"
            : result.status === "partial"
              ? "finished (partial — stopped early)"
              : result.status === "killed"
                ? "killed (did not finish)"
                : "failed"
        const line = `${verb}: ${clip(result.summary, 600)}`
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
        yield* emit(entry.label, line, at, entry.parentKey ?? undefined)
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

    // RUNNING children only — a finished child's record is in the durable
    // store; gathers union this with the tree (`wait_for_agents`), so "watch
    // everything I spawned" still reports long-finished agents without the bus
    // holding a bounded, aging done-map.
    childrenOf: (parentKey) =>
      Ref.get(ref).pipe(
        Effect.map((s) =>
          [...s.running.entries()]
            .filter(([, e]) => e.parentKey === parentKey)
            .map(([nodeId]) => nodeId),
        ),
      ),

    runningChildrenOf: (parentKey) =>
      Ref.get(ref).pipe(
        Effect.map((s) =>
          [...s.running.entries()]
            .filter(([, e]) => e.parentKey === parentKey)
            .map(([nodeId]) => nodeId),
        ),
      ),

    interrupt: (nodeId, by) =>
      Effect.gen(function* () {
        const fiber = yield* stampInterrupted([nodeId], by ?? "parent").pipe(
          Effect.map((fibers) => fibers[0]),
        )
        if (fiber === undefined) return false
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        return true
      }),

    interruptSubtree: (parentKey, by) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(ref)
        // BFS over the running entries' parent links from `parentKey` — a
        // snapshot walk (a child spawned mid-interrupt is orphan-proofed by its
        // parent's interruption landing before the next spawn can register).
        const byParent = new Map<string, Array<string>>()
        for (const [nodeId, e] of s.running.entries()) {
          if (e.parentKey === null) continue
          const arr = byParent.get(e.parentKey) ?? []
          arr.push(nodeId)
          byParent.set(e.parentKey, arr)
        }
        const seen = new Set<string>()
        let frontier = [parentKey]
        while (frontier.length > 0) {
          const next: string[] = []
          for (const key of frontier) {
            for (const child of byParent.get(key) ?? []) {
              if (seen.has(child)) continue
              seen.add(child)
              next.push(child)
            }
          }
          frontier = next
        }
        const fibers = yield* stampInterrupted([...seen], by ?? "parent")
        yield* Effect.forEach(fibers, (f) => Fiber.interrupt(f).pipe(Effect.ignore), {
          discard: true,
        })
      }),

    interruptAll: (by) =>
      Effect.gen(function* () {
        const ids = yield* Ref.get(ref).pipe(Effect.map((s) => [...s.running.keys()]))
        const fibers = yield* stampInterrupted(ids, by ?? "shutdown")
        yield* Effect.forEach(fibers, (f) => Fiber.interrupt(f).pipe(Effect.ignore), {
          discard: true,
        })
      }),

    interruptReasonOf: (nodeId) =>
      Ref.get(ref).pipe(Effect.map((s) => s.running.get(nodeId)?.interruptedBy)),

    setHealth: (nodeId, patch) =>
      Effect.gen(function* () {
        const emit = yield* Ref.modify(ref, (s) => {
          const e = s.running.get(nodeId)
          if (e === undefined) {
            return [undefined as RunHealth | undefined, s] as const
          }
          const prev = e.health
          const health: RunHealth = {
            state: patch.state ?? prev?.state ?? "starting",
            lastActivityAt: patch.at,
            ...(patch.detail !== undefined
              ? { detail: patch.detail }
              : patch.state === undefined && prev?.detail !== undefined
                ? { detail: prev.detail }
                : {}),
            ...(patch.tokens !== undefined
              ? { tokens: patch.tokens }
              : prev?.tokens !== undefined
                ? { tokens: prev.tokens }
                : {}),
          }
          // Edge-triggered: a state CHANGE always emits; same-state activity
          // re-emits only when the last emission is a bucket (15s) old — so the
          // ledger sees transitions, never a per-token heartbeat.
          const stateChanged = prev?.state !== health.state
          const stale =
            e.healthEmittedAt === undefined || patch.at - e.healthEmittedAt >= 15_000
          const doEmit = stateChanged || stale
          const running = new Map(s.running)
          running.set(nodeId, {
            ...e,
            health,
            healthEmittedAt: doEmit ? patch.at : e.healthEmittedAt,
          })
          return [doEmit ? health : undefined, { ...s, running }] as const
        })
        if (emit !== undefined && onEvent !== undefined) {
          yield* onEvent({
            type: "agent_health",
            nodeId,
            state: emit.state,
            lastActivityAt: emit.lastActivityAt,
            ...(emit.detail !== undefined ? { detail: emit.detail } : {}),
            ...(emit.tokens !== undefined ? { tokens: emit.tokens } : {}),
          }).pipe(Effect.catchAllCause(() => Effect.void))
        }
      }),

    healthOf: (nodeId) =>
      Ref.get(ref).pipe(Effect.map((s) => s.running.get(nodeId)?.health)),

    forkSupervised: (effect) => Effect.forkIn(effect, fleetScope),

    shutdown: () =>
      Effect.gen(function* () {
        const ids = yield* Ref.get(ref).pipe(Effect.map((s) => [...s.running.keys()]))
        yield* stampInterrupted(ids, "shutdown")
        // Close the fleet scope: every supervised fiber is interrupted and
        // AWAITED, so each run's finalizer records `killed(shutdown)` — no more
        // rows stranded `running` by a process exit.
        yield* Scope.close(fleetScope, Exit.void)
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
        yield* emit(msg.from, msg.content, msg.at, nodeId)
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
              : [...s.running.keys()]
          return ids.flatMap((id) => {
            const snap = snapshotOne(s, id)
            return snap !== undefined ? [snap] : []
          })
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
