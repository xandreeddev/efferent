import { homedir } from "node:os"
import { Clock, Effect, Fiber, Layer, Ref, Runtime, Schema, Stream } from "effect"
import type { LanguageModel } from "@effect/ai"
import {
  ContextTreeStore,
  ConversationStore,
  FileSystem,
  Http,
  Shell,
  UtilityLlm,
  WebSearch,
  ContextNodeId,
  ConversationId,
  generateSessionTitle,
  renderDirectiveSection,
  resumeAgent,
  runAgent,
  runAutoDistill,
  SettingsStore,
  Verifier,
  Workspace,
  WorkspaceError,
  conversationSessionId,
  nodeSessionId,
  sessionConversationId,
  sessionNodeId,
  initialPhaseState,
  reducePhase,
  submittedPhaseState,
  type AgentPhase,
  type PhaseState,
  type AgentContextNode,
  type AgentDefinition,
  type Approval,
  type Directive,
  type Job,
  type Scope,
  type Memory,
  type Skill,
  type AgentHooks,
  type ApprovalDecision,
  type ScopeRuntime,
  type SeqEvent,
  type SessionId,
  type SessionState,
  type SessionSummary,
  type WorkspaceSnapshot,
} from "@xandreed/sdk-core"
import { buildScopeRuntime, inboxToMessages } from "@xandreed/sdk-core"
import { coderAgentConfig } from "../usecases/coderAgentConfig.js"
import { loadConstraintIds } from "../usecases/loadConstraintIds.js"
import { coderPrompt } from "../prompts/coder.js"
import { importAgentsFromGithub, importToolsFromGithub } from "../usecases/importAgents.js"
import type { InstructionFile } from "../usecases/discoverInstructionFiles.js"
import type { ToolDefinition } from "@xandreed/sdk-core"
import type { FleetSupervisor } from "../cli/state/fleet.js"
import { makeAgentEventHooks, type AgentEvent } from "../events.js"
import { join } from "node:path"
import { formatFullError, inspectError } from "../cli/util/errorFormat.js"
import { makeEventLedger, type EventLedger } from "./eventLedger.js"
import { makeServerApproval } from "./serverApproval.js"
import { readWorkspaceMetrics } from "./metrics.js"

/**
 * The **in-process Workspace** — the authoritative owner of live agent state,
 * and the impl the daemon hosts (the HTTP/SSE transport just exposes it).
 *
 * Control-plane model: the daemon is the cluster; each **fleet** is a root
 * coordinator conversation + its sub-agent subtree (a "deployment"); each agent
 * is a context node (a "pod"). The adapter hosts **N fleets** over one shared
 * `buildScopeRuntime` (one bus + one folder-locks map + one event ledger — these
 * MUST be workspace-wide: the blackboard is cross-fleet and two fleets writing a
 * folder serialize). Only the per-fleet run state (busy/fiber/queue, first-
 * exchange, pinned model) is per-fleet.
 *
 * Per-fleet **model pinning** is the config-safety mechanism: each fleet pins its
 * chat model (seeded from `settings.model`), threaded onto the run via
 * `runAgent(modelOverride)` → `RunContext.modelOverride` → the router. Changing
 * the global default never touches a running fleet.
 *
 * One ledger carries the whole workspace stream (root + sub-agent events, each
 * stamped with its `nodeId`); `subscribe` returns it (clients demux). Approval is
 * the built-in server approval unless the caller overrides (tests/allow-all).
 */
export type WorkspaceRunServices =
  | FileSystem
  | Http
  | Shell
  | WebSearch
  | ConversationStore
  | ContextTreeStore
  | SettingsStore
  | UtilityLlm
  | Verifier
  | LanguageModel.LanguageModel

/** A fleet to seed at build (the daemon passes the workspace's conversations). */
export interface FleetSeed {
  readonly cid: ConversationId
  readonly model?: string
  readonly title?: string
}

export interface InProcessWorkspaceDeps {
  /** The fleets (root coordinators) to host at build — from `conv.listByWorkspace`
   *  in the daemon, or explicit in tests. `createFleet` adds more. */
  readonly roots: ReadonlyArray<FleetSeed>
  readonly rootScope: Scope
  readonly cwd: string
  readonly skills: ReadonlyArray<Skill>
  readonly memory: ReadonlyArray<Memory>
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly instructionFiles: ReadonlyArray<InstructionFile>
  /** Override the bash-approval layer (e.g. allow-all in tests). When omitted,
   *  the adapter uses its built-in **server approval**. */
  readonly approvalLayer?: Layer.Layer<Approval, never, SettingsStore | UtilityLlm>
  /** Live registry of detached fired agents (`:stop` / counts). */
  readonly fleet: FleetSupervisor
  /** With an `approvalLayer` override that resolves client-side, this honours
   *  `approve`. Ignored when the built-in server approval is active. */
  readonly resolveApproval?: (decision: ApprovalDecision) => void
  /** Allow the bash tool (default true, as the TUI does). */
  readonly allowBash?: boolean
}

/** Per-session run state (busy/fiber/queue), keyed by session key. */
interface RunState {
  readonly busy: boolean
  readonly fiber: Fiber.RuntimeFiber<void, never> | undefined
  readonly queue: ReadonlyArray<string>
}

/** Per-fleet record — the live coordinator set the daemon hosts. */
interface FleetState {
  readonly rootCid: ConversationId
  /** Pinned chat model (`"<provider>:<modelId>"`); undefined ⇒ global default. */
  readonly model: string | undefined
  readonly title: string | undefined
  /** Title-on-first-exchange flag (was a module boolean; now per fleet). */
  readonly firstExchangePending: boolean
  readonly lastTouched: number
}

const wsError = (message: string): WorkspaceError => new WorkspaceError({ message })

/** How often the stranded-node sweeper ticks. */
export const SWEEP_INTERVAL_MS = 30_000
/**
 * Grace window before a `running` DB node with no live bus fiber is declared
 * stranded. Bus liveness is the primary signal (a wedged/dead fiber has already
 * left the bus); the window is a belt-and-braces guard against a brief race
 * where a node is persisted `running` a beat before its bus mailbox registers
 * (or just after `markDone`/`complete` removed it but before `recordReturn`).
 */
export const SWEEP_GRACE_MS = 120_000

/**
 * The PURE sweep decision for one node — extracted so it's unit-testable without
 * a daemon. A node is stranded (and should be flipped to `error`) iff it's still
 * `running` in the DB, the orchestration bus does NOT know it as running (its
 * fiber wedged or died, taking its mailbox with it), AND it's older than the
 * grace window (so a legitimately slow turn or a just-spawned node isn't killed).
 */
export const shouldSweepNode = (input: {
  readonly status: AgentContextNode["status"]
  readonly isRunningOnBus: boolean
  readonly createdAt: number
  readonly now: number
  readonly graceMs?: number
}): boolean =>
  input.status === "running" &&
  !input.isRunningOnBus &&
  input.now - input.createdAt >= (input.graceMs ?? SWEEP_GRACE_MS)

export type InProcessWorkspace = ReturnType<typeof Workspace.of>

/**
 * The **JobController** — the one entry that unifies how a turn starts. The three
 * sources (a human typing, a message queued while busy, a cron tick) used to take
 * three different primitives with three different (and for scheduled, MISSING)
 * setups of mission + interaction policy. `submitJob` is a thin router over the
 * existing primitives that sets those CONSISTENTLY:
 *
 *   - `source: "scheduled"`  → `spawnAgent`, but with `mission = job.prompt` (so
 *     the unattended run + its sub-agents know the overall goal — the bare
 *     `spawnAgent` never seeded this) and `interactionPolicy: "headless"` (so its
 *     approval parks-and-denies rather than blocking on an absent human).
 *   - `source: "interactive"` / `"queued"` → the existing `send`/queue path,
 *     interactive policy (a human is watching).
 *
 * It is NOT a rewrite of the primitives — just the consistent policy + mission
 * seam in front of them.
 */
export interface JobController {
  readonly submitJob: (
    job: Job,
  ) => Effect.Effect<
    { readonly conversationId: ConversationId; readonly nodeId?: ContextNodeId },
    never,
    WorkspaceRunServices
  >
}

/**
 * Build a `JobController` over the routing primitives. `runtime.spawnAgent` is the
 * scheduled path; `send` (when provided — the in-process workspace's `send`/queue)
 * is the interactive path. A caller with no interactive surface (the standalone
 * cron daemon, `modes/daemon.ts`) omits `send`; an interactive/queued job there
 * falls back to a fresh scheduled-style spawn so the entry never silently drops a
 * job.
 *
 * Scheduled runs are provided the caller's `scheduledApproval` (the headless
 * parking approval — never allow-all). The interactive `send` path carries its own
 * (server) approval, so it isn't re-provided here.
 */
export const makeJobController = (input: {
  readonly runtime: Pick<ScopeRuntime, "spawnAgent">
  /** The headless parking approval layer for unattended (scheduled) runs. */
  readonly scheduledApproval: Layer.Layer<Approval, never, SettingsStore | UtilityLlm>
  /** The interactive send/queue path (in-process workspace). Omit when there's
   *  no client surface (the cron-only daemon). */
  readonly send?: (cid: ConversationId, prompt: string) => Effect.Effect<void>
}): JobController => {
  const spawnScheduled = (job: Job) =>
    input.runtime
      .spawnAgent({
        rootConversationId: job.conversationId,
        folder: job.folder,
        task: job.prompt,
        // The fix: seed the overall mission + mark the run unattended, so the
        // scheduled subtree knows the goal AND its approval parks-and-denies.
        mission: job.prompt,
        interactionPolicy: "headless",
        ...(job.agent !== undefined ? { agent: job.agent } : {}),
        ...(job.title !== undefined ? { title: job.title } : {}),
      })
      .pipe(
        Effect.provide(input.scheduledApproval),
        Effect.map((r) => ({ conversationId: job.conversationId, nodeId: r.nodeId })),
        // A scheduled job's failure is already recorded on its context node; the
        // controller never fails (the daemon logs around it).
        Effect.catchAll(() => Effect.succeed({ conversationId: job.conversationId })),
        Effect.catchAllDefect(() => Effect.succeed({ conversationId: job.conversationId })),
      ) as Effect.Effect<
        { conversationId: ConversationId; nodeId?: ContextNodeId },
        never,
        WorkspaceRunServices
      >

  return {
    submitJob: (job) =>
      job.source === "scheduled"
        ? spawnScheduled(job)
        : input.send !== undefined
          ? input
              .send(job.conversationId, job.prompt)
              .pipe(Effect.as({ conversationId: job.conversationId }))
          : // No interactive surface here → run it like a scheduled spawn rather
            // than drop it. (The standalone cron daemon only ever submits
            // scheduled jobs, so this branch is a safety net.)
            spawnScheduled({ ...job, source: "scheduled", interactionPolicy: "headless" }),
  }
}

/**
 * Build the in-process Workspace service. Requires the agent-run services in
 * context (the daemon's `AppLive` provides a superset); captures the runtime so
 * `send`/`spawn`/`createFleet` fork detached daemon fibers.
 */
export const makeInProcessWorkspace = (
  deps: InProcessWorkspaceDeps,
): Effect.Effect<InProcessWorkspace, never, WorkspaceRunServices> =>
  Effect.gen(function* () {
    const rt = yield* Effect.runtime<WorkspaceRunServices>()
    const conv = yield* ConversationStore
    const tree = yield* ContextTreeStore
    const settingsStore = yield* SettingsStore
    const fs = yield* FileSystem
    const http = yield* Http
    const startedAt = Date.now()

    // One ledger for the workspace stream; the bus's baseHooks + every run
    // publish here, and any number of clients tail it via `subscribe`.
    const ledger: EventLedger = yield* makeEventLedger()
    // Set once `startResumeTurn` exists: when a TOP-LEVEL lead finishes, this
    // nudges the orchestrator to resume and report the result (see below). It's
    // a forward reference because publish is the single event chokepoint but
    // the resume primitive is defined much later — both are only ever CALLED at
    // runtime, by when the binding is set.
    let onTopLevelDone: (nodeId: string) => Effect.Effect<void> = () => Effect.void
    const publish = (event: AgentEvent): Effect.Effect<void> =>
      ledger
        .publish(event)
        .pipe(
          Effect.zipRight(
            event.type === "subagent_end" && event.nodeId !== undefined
              ? onTopLevelDone(event.nodeId)
              : Effect.void,
          ),
          Effect.asVoid,
        )

    // Approval: the built-in server approval unless overridden (tests/allow-all).
    const serverApproval = makeServerApproval(publish)
    const usingServerApproval = deps.approvalLayer === undefined
    const approvalLayer = deps.approvalLayer ?? serverApproval.layer

    // One shared scope runtime (bus + folder-locks + ledger) for ALL fleets.
    const baseHooks = makeAgentEventHooks(publish)
    const scopeRuntime = buildScopeRuntime(
      deps.rootScope,
      {
        skills: deps.skills,
        memory: deps.memory,
        agents: deps.agents,
        tools: deps.tools,
        allowBash: deps.allowBash ?? true,
        // Mirror inter-agent messages onto the ledger as `board_note` events —
        // the dashboard's "messages flying" stream is then just the SSE stream.
        onBusEvent: publish,
      },
      baseHooks,
    )

    const runStates = yield* Ref.make(new Map<string, RunState>())
    const directiveRef = yield* Ref.make<Directive | undefined>(undefined)
    // Roots with an auto-delivery resume in flight — guards two near-simultaneous
    // top-level completions from each kicking off a resume turn.
    const autoDelivering = yield* Ref.make(new Set<string>())

    // The daemon-AUTHORITATIVE per-session lifecycle phase. Each root turn's
    // events are folded through `reducePhase` (the same rules the client's
    // `agentState` machine uses), so `getState(id).phase` lets a (re)attaching
    // client seed/reconcile its spinner instead of inferring from `busy` — the
    // fix for the phantom "thinking" that survived a detach/re-attach.
    const phases = yield* Ref.make(new Map<string, PhaseState>())
    const setPhase = (key: string, ps: PhaseState): Effect.Effect<void> =>
      Ref.update(phases, (m) => new Map(m).set(key, ps))
    const getPhase = (key: string): Effect.Effect<AgentPhase> =>
      Ref.get(phases).pipe(Effect.map((m) => (m.get(key) ?? initialPhaseState).phase))
    // A root-tagged publish: fold the event into THIS root's phase (sub-agent
    // events carry a nodeId and `reducePhase` already ignores them), then publish
    // to the shared ledger. The root turn's hooks are built over this.
    const publishForRoot =
      (rootKey: string) =>
      (event: AgentEvent): Effect.Effect<void> =>
        Ref.update(phases, (m) => {
          const cur = m.get(rootKey) ?? initialPhaseState
          return new Map(m).set(rootKey, reducePhase(cur, event))
        }).pipe(Effect.zipRight(publish(event)))

    // The live fleet set, seeded from deps.roots, grown by createFleet.
    const fleets = yield* Ref.make(
      new Map<string, FleetState>(
        deps.roots.map((r) => [
          r.cid as string,
          {
            rootCid: r.cid,
            model: r.model,
            title: r.title,
            firstExchangePending: false,
            lastTouched: 0,
          },
        ]),
      ),
    )
    const getFleet = (key: string): Effect.Effect<FleetState | undefined> =>
      Ref.get(fleets).pipe(Effect.map((m) => m.get(key)))
    const isFleetRoot = (key: string): Effect.Effect<boolean> =>
      Ref.get(fleets).pipe(Effect.map((m) => m.has(key)))
    const updateFleet = (key: string, f: (s: FleetState) => FleetState): Effect.Effect<void> =>
      Ref.update(fleets, (m) => {
        const s = m.get(key)
        if (s === undefined) return m
        const nm = new Map(m)
        nm.set(key, f(s))
        return nm
      })
    /** The most-recently-touched fleet (a default seat when no `--fleet`). */
    const mostRecentFleet = (): Effect.Effect<FleetState | undefined> =>
      Ref.get(fleets).pipe(
        Effect.map((m) =>
          [...m.values()].sort((a, b) => b.lastTouched - a.lastTouched)[0],
        ),
      )

    const getRun = (key: string): Effect.Effect<RunState> =>
      Ref.get(runStates).pipe(
        Effect.map((m) => m.get(key) ?? { busy: false, fiber: undefined, queue: [] }),
      )
    const setRun = (key: string, f: (s: RunState) => RunState): Effect.Effect<void> =>
      Ref.update(runStates, (m) => {
        const next = new Map(m)
        next.set(key, f(m.get(key) ?? { busy: false, fiber: undefined, queue: [] }))
        return next
      })

    // --- the run-fork (UI-free `submit`), per fleet -------------------------

    const buildRootPrompt = () =>
      Effect.gen(function* () {
        const base = coderPrompt(
          deps.cwd,
          new Date(),
          deps.skills,
          deps.instructionFiles,
          deps.agents,
          deps.tools,
          undefined,
          deps.memory,
        )
        const directive = yield* Ref.get(directiveRef)
        const directiveText = renderDirectiveSection(directive)
        return directiveText.length > 0 ? { ...base, text: base.text + directiveText } : base
      })

    const rootHooksFor = (rootKey: string): AgentHooks<never> => ({
      // Lifecycle events flow through the root-tagged publish so this session's
      // authoritative phase advances; everything else is identical to baseHooks.
      ...makeAgentEventHooks(publishForRoot(rootKey)),
      onTransformContext: (messages) =>
        Effect.gen(function* () {
          const inbox = yield* scopeRuntime.bus.drain(rootKey)
          return inbox.length === 0 ? messages : [...messages, ...inboxToMessages(inbox)]
        }),
    })

    const finishTurn = (key: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const leftover = yield* scopeRuntime.bus.drain(key)
        yield* scopeRuntime.bus.markDone(key)
        // The root turn ended on EVERY path (success, error, interrupt) — settle
        // the authoritative phase to idle so a (re)attaching client can never be
        // left showing a stale "thinking" (an interrupt emits no agent_end). If a
        // queued message starts the next turn below, startRootTurn re-flips it.
        yield* setPhase(key, initialPhaseState)
        yield* setRun(key, (s) => ({
          busy: false,
          fiber: undefined,
          queue: [...s.queue, ...leftover.filter((m) => m.from === "you").map((m) => m.content)],
        }))
        // First exchange just landed → name THIS fleet on the fast tier.
        const fleet = yield* getFleet(key)
        if (fleet !== undefined && fleet.firstExchangePending) {
          yield* updateFleet(key, (s) => ({ ...s, firstExchangePending: false }))
          const cid = fleet.rootCid
          const titleEffect = Effect.gen(function* () {
            const history = yield* conv.list(cid)
            const res = yield* generateSessionTitle(history)
            if (res.usage !== undefined) {
              yield* publish({ type: "helper_usage", role: "fast", usage: res.usage })
            }
            if (res.title.length > 0) yield* conv.setTitle(cid, res.title)
          }).pipe(Effect.ignore)
          yield* Effect.sync(() => {
            Runtime.runFork(rt)(titleEffect)
          })
        }
        // Take EVERYTHING available (agy): drain the whole queue into the next
        // turn at once, not one-per-turn (which left later messages waiting
        // across turns). Joined oldest-first into a single combined turn.
        const next = yield* Ref.modify(runStates, (m) => {
          const s = m.get(key)
          if (s === undefined || s.queue.length === 0) return [undefined, m]
          const combined = s.queue.join("\n\n")
          const nm = new Map(m)
          nm.set(key, { ...s, queue: [] })
          return [combined, nm]
        })
        // Learn for next runs: at a true turn boundary (nothing queued), mine
        // this conversation for reusable lessons and persist them so the NEXT
        // turn inherits them — the self-improving loop's "learn" step. Background
        // + fail-soft. This closes the loop on the DEFAULT daemon path, which
        // previously never distilled (only `efferent code` did).
        if (next === undefined && fleet !== undefined) {
          const settings = yield* settingsStore.get()
          if (settings.autoDistill !== false) {
            const cid = fleet.rootCid
            const distillEffect = Effect.gen(function* () {
              const constraintIds = yield* loadConstraintIds(deps.cwd)
              const existing = [
                ...deps.skills.map((s) => s.name),
                ...deps.memory.map((m) => m.name),
                ...constraintIds,
              ]
              return yield* runAutoDistill({
                conversationId: cid,
                repoDir: deps.cwd,
                globalDir: homedir(),
                existing,
              }).pipe(
                Effect.flatMap((saved) =>
                  saved.length === 0
                    ? Effect.void
                    : publish({
                        type: "learned",
                        lessons: saved.map((r) => ({
                          name: r.candidate.name,
                          kind: r.candidate.kind,
                        })),
                      }),
                ),
                Effect.ignore,
              )
            })
            yield* Effect.sync(() => {
              Runtime.runFork(rt)(distillEffect)
            })
          }
        }
        if (next !== undefined && fleet !== undefined) yield* startRootTurn(fleet.rootCid, next)
      })

    const startRootTurn = (rootCid: ConversationId, text: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const rootKey = rootCid as string
        const empty = (yield* conv.listActive(rootCid).pipe(Effect.orElseSucceed(() => []))).length === 0
        yield* updateFleet(rootKey, (s) => ({
          ...s,
          firstExchangePending: empty,
          lastTouched: Date.now(),
        }))
        const model = (yield* getFleet(rootKey))?.model
        const prompt = yield* buildRootPrompt()
        const runEffect = runAgent(
          coderAgentConfig(deps.rootScope, scopeRuntime, prompt),
          rootCid,
          text,
          rootHooksFor(rootKey),
          deps.cwd,
          model,
        ).pipe(
          Effect.provide(scopeRuntime.handlerLayer),
          Effect.provide(approvalLayer),
          Effect.catchAll((err) =>
            Effect.logError(inspectError(err)).pipe(
              Effect.zipRight(publish({ type: "error", message: formatFullError(err) })),
            ),
          ),
          Effect.catchAllDefect((d) =>
            Effect.logError(`agent run crashed: ${String(d)}`).pipe(
              Effect.zipRight(publish({ type: "error", message: `agent run crashed: ${String(d)}` })),
            ),
          ),
          Effect.asVoid,
          Effect.ensuring(finishTurn(rootKey)),
        ) as Effect.Effect<void, never, WorkspaceRunServices>
        // Optimistically flip to thinking the instant the turn starts, so a
        // client attaching in the model-latency gap (before turn_start lands)
        // already sees the spinner; the first event reconciles from there.
        yield* setPhase(rootKey, submittedPhaseState)
        yield* scopeRuntime.bus.markRunning(rootKey, "you")
        const fiber = Runtime.runFork(rt)(runEffect)
        yield* setRun(rootKey, (s) => ({ ...s, busy: true, fiber }))
      })

    // Re-drive an in-flight fleet turn after a crash (restorability).
    const startResumeTurn = (rootCid: ConversationId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const rootKey = rootCid as string
        const model = (yield* getFleet(rootKey))?.model
        const prompt = yield* buildRootPrompt()
        const runEffect = resumeAgent(
          coderAgentConfig(deps.rootScope, scopeRuntime, prompt),
          rootCid,
          rootHooksFor(rootKey),
          deps.cwd,
          model,
        ).pipe(
          Effect.provide(scopeRuntime.handlerLayer),
          Effect.provide(approvalLayer),
          Effect.catchAll((err) =>
            Effect.logError(inspectError(err)).pipe(
              Effect.zipRight(publish({ type: "error", message: formatFullError(err) })),
            ),
          ),
          Effect.catchAllDefect((d) =>
            Effect.logError(`resume crashed: ${String(d)}`).pipe(
              Effect.zipRight(publish({ type: "error", message: `resume crashed: ${String(d)}` })),
            ),
          ),
          Effect.asVoid,
          Effect.ensuring(finishTurn(rootKey)),
        ) as Effect.Effect<void, never, WorkspaceRunServices>
        yield* setPhase(rootKey, submittedPhaseState)
        yield* scopeRuntime.bus.markRunning(rootKey, "you")
        const fiber = Runtime.runFork(rt)(runEffect)
        yield* setRun(rootKey, (s) => ({ ...s, busy: true, fiber }))
      })

    // The async "report back when done": when a TOP-LEVEL lead (spawned by the
    // root, so `parentId === null`) finishes and its root has NO turn running,
    // resume the orchestrator. Its inbox-draining hook folds in the completion
    // the bus delivered, so it reports the result to the user in its own voice —
    // exactly what happens when the human pokes it, but automatic. A BUSY root
    // needs no nudge: it folds the completion in at its own next boundary.
    // Deeper specialists (parentId set) are the lead's concern, never surfaced.
    onTopLevelDone = (nodeId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(ContextNodeId)(nodeId).pipe(Effect.option)
        if (decoded._tag === "None") return
        const node = yield* tree.get(decoded.value).pipe(Effect.option)
        if (
          node._tag === "None" ||
          node.value.parentId !== null ||
          node.value.rootConversationId === null
        ) {
          return
        }
        const rootCid = node.value.rootConversationId
        const rootKey = rootCid as string
        if ((yield* getRun(rootKey)).busy) return
        const claimed = yield* Ref.modify(autoDelivering, (s) =>
          s.has(rootKey) ? [false, s] : [true, new Set(s).add(rootKey)],
        )
        if (!claimed) return
        yield* startResumeTurn(rootCid).pipe(
          Effect.ensuring(
            Ref.update(autoDelivering, (s) => {
              const ns = new Set(s)
              ns.delete(rootKey)
              return ns
            }),
          ),
        )
      }).pipe(Effect.forkDaemon, Effect.asVoid)

    // Resume a finished agent node in place (the human-driven seedMode:"resume").
    const startNodeResume = (
      nodeId: ContextNodeId,
      text: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const settings = yield* settingsStore.get()
        const runEffect = scopeRuntime
          .resumeNode({
            nodeId,
            task: text,
            ...(settings.subAgentTokenBudget !== undefined
              ? { budget: settings.subAgentTokenBudget }
              : {}),
            ...(settings.subAgentMaxSteps !== undefined
              ? { maxSteps: settings.subAgentMaxSteps }
              : {}),
          })
          .pipe(
            Effect.provide(approvalLayer),
            Effect.catchAll((f) =>
              publish({
                type: "error",
                message: f.message !== undefined ? `${f.error}: ${f.message}` : f.error,
              }),
            ),
            Effect.catchAllDefect((d) =>
              publish({ type: "error", message: `node resume crashed: ${String(d)}` }),
            ),
            Effect.asVoid,
            Effect.ensuring(setRun(nodeId, (s) => ({ ...s, busy: false, fiber: undefined }))),
          ) as Effect.Effect<void, never, WorkspaceRunServices>
        const fiber = Runtime.runFork(rt)(runEffect)
        yield* setRun(nodeId, (s) => ({ ...s, busy: true, fiber }))
      })

    // --- session summaries (all fleets) -------------------------------------

    const rootSummary = (fleet: FleetState, busy: boolean): SessionSummary => ({
      id: conversationSessionId(fleet.rootCid),
      kind: "root",
      ...(fleet.title !== undefined ? { title: fleet.title } : {}),
      folder: deps.cwd,
      status: busy ? "running" : "idle",
      parentId: null,
      ...(fleet.model !== undefined ? { model: fleet.model } : {}),
    })

    const listSummaries = (): Effect.Effect<ReadonlyArray<SessionSummary>, WorkspaceError> =>
      Effect.gen(function* () {
        const fleetList = [...(yield* Ref.get(fleets)).values()]
        const out: SessionSummary[] = []
        for (const fleet of fleetList) {
          const rootKey = fleet.rootCid as string
          const busy = (yield* getRun(rootKey)).busy
          out.push(rootSummary(fleet, busy))
          const nodes = yield* tree
            .listTree(fleet.rootCid)
            .pipe(Effect.mapError((e) => wsError(e.message)))
          for (const n of nodes) {
            out.push({
              id: nodeSessionId(n.id),
              kind: "agent",
              ...(n.title !== undefined ? { title: n.title } : {}),
              folder: n.folder,
              status: n.status,
              parentId:
                n.parentId !== null ? nodeSessionId(n.parentId) : conversationSessionId(fleet.rootCid),
            })
          }
        }
        return out
      })

    /** Collect a fleet's running descendant keys (BFS via the bus), for a
     *  fleet-scoped interrupt that cancels only THAT deployment. */
    const fleetSubtree = (rootKey: string): Effect.Effect<ReadonlyArray<string>> =>
      Effect.gen(function* () {
        const seen = new Set<string>()
        let frontier = [rootKey]
        while (frontier.length > 0) {
          const next: string[] = []
          for (const k of frontier) {
            const kids = yield* scopeRuntime.bus.childrenOf(k)
            for (const c of kids) if (!seen.has(c)) { seen.add(c); next.push(c) }
          }
          frontier = next
        }
        return [...seen]
      })

    // --- the Workspace service ----------------------------------------------

    const service = Workspace.of({
      snapshot: () =>
        Effect.gen(function* () {
          const sessions = yield* listSummaries()
          const directive = yield* Ref.get(directiveRef)
          const recent = yield* mostRecentFleet()
          return {
            sessions,
            directive: directive ?? null,
            activeSessionId: recent !== undefined ? conversationSessionId(recent.rootCid) : null,
          } satisfies WorkspaceSnapshot
        }),

      listSessions: () => listSummaries(),

      getState: (id) =>
        Effect.gen(function* () {
          const sessions = yield* listSummaries()
          const session = sessions.find((s) => s.id === id)
          const cursor = yield* ledger.latestSeq
          const run = yield* getRun(id as string)
          const busy = run.busy
          const kind = session?.kind ?? "root"
          const log =
            kind === "root"
              ? yield* conv
                  .listActive(sessionConversationId(id))
                  .pipe(Effect.mapError((e) => wsError(e.message)))
              : yield* tree
                  .listMessages(sessionNodeId(id))
                  .pipe(Effect.mapError((e) => wsError(e.message)))
          // The absolute position of log[0]: after a handoff narrows the active
          // window, listActive starts past the checkpoint, so the client must
          // offset its position-derived block keys to match the live event
          // stream (which carries true store positions). Node logs aren't folded
          // → offset 0.
          const checkpoint =
            kind === "root"
              ? yield* conv
                  .getLatestCheckpoint(sessionConversationId(id))
                  .pipe(Effect.mapError((e) => wsError(e.message)))
              : undefined
          const logBaseOffset = checkpoint !== undefined ? checkpoint.messagePosition + 1 : 0
          const pendingApproval = usingServerApproval
            ? serverApproval.pendingFor(id as string) ?? null
            : null
          const fallback: SessionSummary = {
            id,
            kind: "root",
            folder: deps.cwd,
            status: busy ? "running" : "idle",
            parentId: null,
          }
          // The authoritative phase. A root reads its folded phase ledger; an
          // agent node has no per-event phase, so derive it from the bus (live →
          // thinking, else idle) — enough for a paired client to seed correctly.
          const phase: AgentPhase =
            kind === "root"
              ? yield* getPhase(id as string)
              : (yield* scopeRuntime.bus.isRunning(id as string))
                ? "thinking"
                : "idle"
          return {
            session: session ?? fallback,
            log,
            logBaseOffset,
            busy,
            phase,
            queue: run.queue,
            pendingApproval,
            cursor,
          } satisfies SessionState
        }),

      send: (id, prompt) =>
        Effect.gen(function* () {
          const key = id as string
          const fleetRoot = yield* isFleetRoot(key)
          // A sub-agent you're PAIRED with (its preview is open) and which is
          // live: deliver to its mailbox — it reads at its next step, you keep
          // pairing without resuming a finished node. The root never takes this
          // path: messages to the lead QUEUE (agy-style) rather than injecting
          // mid-turn — see below. (Sub-agent RESULTS still flow into the root via
          // its mailbox + `onTransformContext`; that's a different, untouched path.)
          if (!fleetRoot) {
            const running = yield* scopeRuntime.bus.isRunning(key)
            if (running) {
              const at = yield* Clock.currentTimeMillis
              yield* scopeRuntime.bus.post(key, { from: "you", content: prompt, at })
              return
            }
          }
          // Busy (the root mid-turn, or any session between turns) → hold it as a
          // pending `▸` message; the turn-end queue drain runs it as the next turn.
          if ((yield* getRun(key)).busy) {
            yield* setRun(key, (s) => ({ ...s, queue: [...s.queue, prompt] }))
            return
          }
          if (fleetRoot) {
            yield* startRootTurn(sessionConversationId(id), prompt)
          } else {
            yield* startNodeResume(sessionNodeId(id), prompt)
          }
        }).pipe(Effect.catchAllDefect((d) => Effect.fail(wsError(`send failed: ${String(d)}`)))),

      interrupt: (id) =>
        Effect.gen(function* () {
          const key = id as string
          if (yield* isFleetRoot(key)) {
            // Cancel only THIS fleet's subtree (not interruptAll — that would
            // kill every fleet; reserved for daemon shutdown).
            const subtree = yield* fleetSubtree(key)
            yield* Effect.forEach(subtree, (k) => scopeRuntime.bus.interrupt(k).pipe(Effect.asVoid), {
              discard: true,
            })
          } else {
            yield* scopeRuntime.bus.interrupt(key).pipe(Effect.asVoid)
          }
          const fiber = (yield* getRun(key)).fiber
          if (fiber !== undefined) yield* Fiber.interrupt(fiber)
        }),

      clearQueue: (id) =>
        // Drop pending messages without touching the running turn (the client
        // pulled them back into its composer to edit). Leaves `busy`/`fiber`.
        setRun(id as string, (s) => ({ ...s, queue: [] })).pipe(
          Effect.catchAllDefect((d) => Effect.fail(wsError(`clearQueue failed: ${String(d)}`))),
        ),

      spawn: (req) =>
        Effect.gen(function* () {
          const settings = yield* settingsStore.get()
          // Spawn an agent under the most-recent fleet (the active deployment).
          const recent = yield* mostRecentFleet()
          if (recent === undefined) {
            return yield* Effect.fail(wsError("no fleet to spawn into — create one first"))
          }
          const fleetCid = recent.rootCid
          const id = deps.fleet.nextId()
          const runEffect = scopeRuntime
            .spawnAgent({
              rootConversationId: fleetCid,
              folder: req.folder,
              task: req.task,
              ...(req.title !== undefined ? { title: req.title } : {}),
              ...(req.agent !== undefined ? { agent: req.agent } : {}),
              ...(settings.subAgentTokenBudget !== undefined
                ? { budget: settings.subAgentTokenBudget }
                : {}),
              ...(settings.subAgentMaxSteps !== undefined
                ? { maxSteps: settings.subAgentMaxSteps }
                : {}),
            })
            .pipe(
              Effect.provide(approvalLayer),
              Effect.catchAll((f) =>
                publish({
                  type: "error",
                  message: f.message !== undefined ? `${f.error}: ${f.message}` : f.error,
                }),
              ),
              Effect.catchAllDefect((d) =>
                publish({ type: "error", message: `agent spawn crashed: ${String(d)}` }),
              ),
              Effect.ensuring(Effect.sync(() => deps.fleet.remove(id))),
              Effect.asVoid,
            ) as Effect.Effect<void, never, WorkspaceRunServices>
          const fiber = Runtime.runFork(rt)(runEffect)
          deps.fleet.register(id, {
            fiber,
            title: req.title ?? req.agent ?? req.folder,
            folder: req.folder,
            agent: req.agent ?? "coder",
          })
          // The fresh node id isn't known synchronously — return the fleet root;
          // clients discover the node via the next `subagent_start` / `snapshot`.
          return conversationSessionId(fleetCid)
        }),

      createFleet: (req) =>
        Effect.gen(function* () {
          const settings = yield* settingsStore.get()
          const cid = yield* conv
            .create(deps.cwd)
            .pipe(Effect.mapError((e) => wsError(e.message)))
          const model = req.model ?? settings.model
          if (model !== undefined && model.length > 0) {
            yield* conv.setModel(cid, model).pipe(Effect.mapError((e) => wsError(e.message)))
          }
          yield* Ref.update(fleets, (m) => {
            const nm = new Map(m)
            nm.set(cid as string, {
              rootCid: cid,
              model,
              title: req.title,
              firstExchangePending: false,
              lastTouched: Date.now(),
            })
            return nm
          })
          if (req.task !== undefined && req.task.length > 0) {
            yield* startRootTurn(cid, req.task)
          }
          return conversationSessionId(cid)
        }),

      setFleetModel: (id, model) =>
        Effect.gen(function* () {
          const cid = sessionConversationId(id)
          yield* conv.setModel(cid, model).pipe(Effect.mapError((e) => wsError(e.message)))
          yield* updateFleet(id as string, (s) => ({ ...s, model }))
        }),

      stop: (id) =>
        Effect.gen(function* () {
          yield* scopeRuntime.bus.interrupt(id as string).pipe(Effect.asVoid)
          const fiber = (yield* getRun(id as string)).fiber
          if (fiber !== undefined) yield* Fiber.interrupt(fiber)
        }),

      subscribe: (id, since) => {
        void id
        return ledger.stream(since) as Stream.Stream<SeqEvent, WorkspaceError>
      },

      approve: (_id, decision) =>
        usingServerApproval
          ? serverApproval.resolve(decision)
          : deps.resolveApproval !== undefined
            ? Effect.sync(() => deps.resolveApproval!(decision))
            : Effect.void,

      metrics: () =>
        Effect.gen(function* () {
          const fleetCount = (yield* Ref.get(fleets)).size
          return yield* readWorkspaceMetrics({
            bus: scopeRuntime.bus,
            fleets: fleetCount,
            startedAt,
            now: Date.now(),
          })
        }),

      messages: (limit) =>
        scopeRuntime.bus.boardRead().pipe(
          Effect.map((board) => {
            const tail = limit !== undefined ? board.slice(-limit) : board
            return tail.map((n) => ({ from: n.from, content: n.note, at: n.at }))
          }),
        ),

      getSettings: () => settingsStore.get(),
      updateSettings: (patch) =>
        // The decoded partial only carries the keys the client sent, so the
        // spread overrides exactly those; the cast drops the pessimistic
        // `| undefined` the partial schema's type adds.
        settingsStore.update((curr) => ({ ...curr, ...patch }) as typeof curr),

      getDirective: () => Ref.get(directiveRef),
      setDirective: (d) => Ref.set(directiveRef, d),

      importAgents: (spec) =>
        importAgentsFromGithub(spec, join(deps.cwd, ".efferent/agents")).pipe(
          Effect.map((r) => ({ written: r.written, skipped: r.skipped })),
          Effect.mapError((e) => wsError(e.message)),
          Effect.provideService(FileSystem, fs),
          Effect.provideService(Http, http),
        ),
      importTools: (spec) =>
        importToolsFromGithub(spec, join(deps.cwd, ".efferent/tools")).pipe(
          Effect.map((r) => ({ written: r.written, skipped: r.skipped })),
          Effect.mapError((e) => wsError(e.message)),
          Effect.provideService(FileSystem, fs),
          Effect.provideService(Http, http),
        ),
    })

    // Restorability: re-drive EVERY fleet that had a turn in flight when a prior
    // daemon died. Clear each marker FIRST so a crash mid-resume can't loop it.
    const pending = yield* conv
      .listPending(deps.cwd)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ id: ConversationId; prompt: string }>))
    for (const p of pending) {
      const key = p.id as string
      // Seed a fleet for it if the daemon didn't already (best-effort decode).
      if (!(yield* isFleetRoot(key))) {
        yield* Ref.update(fleets, (m) => {
          const nm = new Map(m)
          nm.set(key, {
            rootCid: p.id,
            model: undefined,
            title: undefined,
            firstExchangePending: false,
            lastTouched: 0,
          })
          return nm
        })
      }
      yield* conv.clearPending(p.id).pipe(Effect.ignore)
      yield* startResumeTurn(p.id)
    }

    // --- mid-session stranded-node sweeper ----------------------------------
    // The daemon's startup reconcile (server/daemon.ts) only flips nodes left
    // `running` by a PRIOR crash. A node whose fiber wedges or dies WHILE the
    // daemon lives would otherwise stay `running` forever in the UI. This
    // background sweeper closes that gap using the bus as ground truth.
    const sweepNode = (node: AgentContextNode): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Re-check liveness right before acting — the periodic snapshot may have
        // gone stale (a node could have started since the tick began).
        const live = yield* scopeRuntime.bus.isRunning(node.id as string)
        const now = yield* Clock.currentTimeMillis
        if (
          !shouldSweepNode({
            status: node.status,
            isRunningOnBus: live,
            createdAt: node.createdAt,
            now,
          })
        ) {
          return
        }
        const summary = "[stalled — no longer running]"
        // 1) Persist the terminal status, so :tree/activity stop showing it live.
        yield* tree
          .recordReturn(node.id, { status: "error", summary, filesChanged: [] })
          .pipe(Effect.ignore)
        // 2) Notify via the SAME bus path a normal completion uses — registering
        //    the (now-absent) node first so `complete` has an entry to read,
        //    which then delivers the failure to the parent's inbox (or buffers it
        //    for the parent's next resume) + the blackboard + wakes any waiter.
        const parentKey = (node.parentId ?? node.rootConversationId ?? null) as string | null
        const label = node.title ?? node.folder
        yield* scopeRuntime.bus.markRunning(node.id as string, label, { parentKey })
        yield* scopeRuntime.bus.complete(node.id as string, {
          status: "error",
          summary,
          filesChanged: [],
        })
        // 3) Publish subagent_end so the UI flips status live AND a TOP-LEVEL
        //    node's parent root auto-resumes to report it (onTopLevelDone).
        yield* publish({
          type: "subagent_end",
          name: label,
          nodeId: node.id as string,
          ok: false,
          summary,
          filesChanged: [],
        })
      }).pipe(Effect.ignore)

    const sweepOnce = Effect.gen(function* () {
      const fleetMap = yield* Ref.get(fleets)
      yield* Effect.forEach(
        [...fleetMap.values()],
        (f) =>
          tree.listTree(f.rootCid).pipe(
            Effect.flatMap((nodes) =>
              Effect.forEach(nodes.filter((n) => n.status === "running"), sweepNode, {
                discard: true,
              }),
            ),
            Effect.ignore,
          ),
        { discard: true },
      )
    }).pipe(Effect.ignore)

    // forkDaemon under the runtime scope → interrupted on teardown; never throws
    // (every step is `Effect.ignore`-guarded), so a transient store error just
    // skips a tick.
    yield* Effect.forkDaemon(
      Effect.forever(Effect.sleep(`${SWEEP_INTERVAL_MS} millis`).pipe(Effect.zipRight(sweepOnce))),
    )

    return service
  })
