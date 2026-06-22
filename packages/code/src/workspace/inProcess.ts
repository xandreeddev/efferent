import { Clock, Effect, Fiber, Layer, Ref, Runtime, Stream } from "effect"
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
  SettingsStore,
  Workspace,
  WorkspaceError,
  conversationSessionId,
  nodeSessionId,
  sessionConversationId,
  sessionNodeId,
  type AgentDefinition,
  type Approval,
  type Directive,
  type Scope,
  type Memory,
  type Skill,
  type AgentHooks,
  type ApprovalDecision,
  type SeqEvent,
  type SessionId,
  type SessionState,
  type SessionSummary,
  type WorkspaceSnapshot,
} from "@xandreed/sdk-core"
import { buildScopeRuntime } from "../usecases/buildScopeRuntime.js"
import { coderAgentConfig } from "../usecases/coderAgentConfig.js"
import { coderPrompt } from "../prompts/coder.js"
import { inboxToMessages } from "../usecases/agentBus.js"
import { importAgentsFromGithub, importToolsFromGithub } from "../usecases/importAgents.js"
import type { InstructionFile } from "../usecases/discoverInstructionFiles.js"
import type { ToolDefinition } from "../usecases/loadTools.js"
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

export type InProcessWorkspace = ReturnType<typeof Workspace.of>

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
    const publish = (event: AgentEvent): Effect.Effect<void> =>
      ledger.publish(event).pipe(Effect.asVoid)

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
      ...baseHooks,
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
        const next = yield* Ref.modify(runStates, (m) => {
          const s = m.get(key)
          if (s === undefined || s.queue.length === 0) return [undefined, m]
          const [head, ...rest] = s.queue
          const nm = new Map(m)
          nm.set(key, { ...s, queue: rest })
          return [head, nm]
        })
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
        yield* scopeRuntime.bus.markRunning(rootKey, "you")
        const fiber = Runtime.runFork(rt)(runEffect)
        yield* setRun(rootKey, (s) => ({ ...s, busy: true, fiber }))
      })

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
          const busy = (yield* getRun(id as string)).busy
          const kind = session?.kind ?? "root"
          const log =
            kind === "root"
              ? yield* conv
                  .listActive(sessionConversationId(id))
                  .pipe(Effect.mapError((e) => wsError(e.message)))
              : yield* tree
                  .listMessages(sessionNodeId(id))
                  .pipe(Effect.mapError((e) => wsError(e.message)))
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
          return {
            session: session ?? fallback,
            log,
            busy,
            pendingApproval,
            cursor,
          } satisfies SessionState
        }),

      send: (id, prompt) =>
        Effect.gen(function* () {
          const key = id as string
          const running = yield* scopeRuntime.bus.isRunning(key)
          if (running) {
            const at = yield* Clock.currentTimeMillis
            yield* scopeRuntime.bus.post(key, { from: "you", content: prompt, at })
            return
          }
          if ((yield* getRun(key)).busy) {
            yield* setRun(key, (s) => ({ ...s, queue: [...s.queue, prompt] }))
            return
          }
          if (yield* isFleetRoot(key)) {
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

    return service
  })
