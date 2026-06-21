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
  type ConversationId,
  type Directive,
  type Scope,
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

/**
 * The **in-process Workspace** — the authoritative owner of live agent state,
 * and the impl the daemon hosts (the HTTP/SSE transport just exposes it). It
 * wraps the real `buildScopeRuntime` + its comms bus + the fleet + a per-
 * workspace `EventLedger` (the PubSub fan-out + reconnect cache that replaces
 * the single `makeEventHooks` queue), plus the directive, and forks agent runs
 * on a captured runtime so a `send` returns immediately while the turn streams.
 *
 * This is the UI-free distillation of `cli/actions/submit.ts` + `spawnAgent.ts`
 * + the directive closure in `runtime.ts`: the run-fork / busy / mailbox /
 * queue logic moves here; the client keeps the presentation (it rebuilds the
 * rail by reducing `subscribe`'s event stream / `getState`'s persisted log).
 *
 * Scope note (phase a): one ledger per workspace carries the whole stream
 * (root + sub-agent events, each stamped with its `nodeId`), exactly like
 * today's single queue — clients demux by `nodeId`. Per-agent-session ledgers
 * are a later refinement. Approval still resolves client-side (the in-process
 * TUI calls its own modal); `approve` routes through an optional resolver until
 * the server-side approval round-trip (phase e) lands.
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

export interface InProcessWorkspaceDeps {
  readonly rootConversationId: ConversationId
  readonly rootScope: Scope
  readonly cwd: string
  readonly skills: ReadonlyArray<Skill>
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly instructionFiles: ReadonlyArray<InstructionFile>
  /** The interactive bash-approval layer, provided to each run (as `submit` did). */
  readonly approvalLayer: Layer.Layer<Approval, never, SettingsStore | UtilityLlm>
  /** Live registry of detached fired agents (`:stop` / counts). */
  readonly fleet: FleetSupervisor
  /** Resolve a pending bash approval (the client's modal answer). Until the
   *  server-side approval round-trip (phase e), the in-process TUI passes its
   *  `makeTuiApproval.resolve` here so `approve` is honoured. */
  readonly resolveApproval?: (decision: ApprovalDecision) => void
  /** Allow the bash tool (default true, as the TUI does). */
  readonly allowBash?: boolean
}

/** Per-session run state owned by the daemon (was the TUI's run handle). */
interface RunState {
  readonly busy: boolean
  readonly fiber: Fiber.RuntimeFiber<void, never> | undefined
  readonly queue: ReadonlyArray<string>
}

const wsError = (message: string): WorkspaceError => new WorkspaceError({ message })

export type InProcessWorkspace = ReturnType<typeof Workspace.of>

/**
 * Build the in-process Workspace service. Requires the agent-run services in
 * context (the daemon's `AppLive` provides a superset); captures the runtime so
 * `send`/`spawn` fork detached daemon fibers.
 */
export const makeInProcessWorkspace = (
  deps: InProcessWorkspaceDeps,
): Effect.Effect<InProcessWorkspace, never, WorkspaceRunServices> =>
  Effect.gen(function* () {
    const rt = yield* Effect.runtime<WorkspaceRunServices>()
    const conv = yield* ConversationStore
    const tree = yield* ContextTreeStore
    const settingsStore = yield* SettingsStore
    // Captured so the import methods (R = FileSystem | Http) stay R=never on the port.
    const fs = yield* FileSystem
    const http = yield* Http

    const rootCid = deps.rootConversationId
    const rootKey = rootCid as string

    // One ledger for the workspace stream; the bus's baseHooks + every run
    // publish here, and any number of clients tail it via `subscribe`.
    const ledger: EventLedger = yield* makeEventLedger()
    const publish = (event: AgentEvent): Effect.Effect<void> =>
      ledger.publish(event).pipe(Effect.asVoid)

    // The scope runtime, built with baseHooks that publish to the ledger — so a
    // sub-agent's events (stamped with its nodeId) reach every client too.
    const baseHooks = makeAgentEventHooks(publish)
    const scopeRuntime = buildScopeRuntime(
      deps.rootScope,
      {
        skills: deps.skills,
        agents: deps.agents,
        tools: deps.tools,
        allowBash: deps.allowBash ?? true,
      },
      baseHooks,
    )

    const runStates = yield* Ref.make(new Map<string, RunState>())
    const directiveRef = yield* Ref.make<Directive | undefined>(undefined)

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

    // --- the run-fork (UI-free `submit`) ------------------------------------

    const finishTurn = (key: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Tear down the live mailbox; requeue a human message that landed after
        // the loop's last turn boundary (so it isn't lost), drop agent notes.
        const leftover = yield* scopeRuntime.bus.drain(key)
        yield* scopeRuntime.bus.markDone(key)
        yield* setRun(key, (s) => ({
          busy: false,
          fiber: undefined,
          queue: [...s.queue, ...leftover.filter((m) => m.from === "you").map((m) => m.content)],
        }))
        const next = yield* Ref.modify(runStates, (m) => {
          const s = m.get(key)
          if (s === undefined || s.queue.length === 0) return [undefined, m]
          const [head, ...rest] = s.queue
          const nm = new Map(m)
          nm.set(key, { ...s, queue: rest })
          return [head, nm]
        })
        if (next !== undefined) yield* startRootTurn(next)
      })

    const startRootTurn = (text: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const base = coderPrompt(
          deps.cwd,
          new Date(),
          deps.skills,
          deps.instructionFiles,
          deps.agents,
          deps.tools,
        )
        const directive = yield* Ref.get(directiveRef)
        const directiveText = renderDirectiveSection(directive)
        const prompt =
          directiveText.length > 0 ? { ...base, text: base.text + directiveText } : base

        // The root gets a mailbox like any agent: a message sent mid-turn is
        // drained + folded in at the next turn boundary.
        const rootHooks: AgentHooks<never> = {
          ...baseHooks,
          onTransformContext: (messages) =>
            Effect.gen(function* () {
              const inbox = yield* scopeRuntime.bus.drain(rootKey)
              return inbox.length === 0 ? messages : [...messages, ...inboxToMessages(inbox)]
            }),
        }

        const runEffect = runAgent(
          coderAgentConfig(deps.rootScope, scopeRuntime, prompt),
          rootCid,
          text,
          rootHooks,
          deps.cwd,
        ).pipe(
          Effect.provide(scopeRuntime.handlerLayer),
          Effect.provide(deps.approvalLayer),
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

    // Re-drive an in-flight root turn after a crash (restorability) — the
    // persisted history already ends with the prompt the turn was answering, so
    // `resumeAgent` continues over it without appending a new prompt.
    const startResumeTurn = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const base = coderPrompt(
          deps.cwd,
          new Date(),
          deps.skills,
          deps.instructionFiles,
          deps.agents,
          deps.tools,
        )
        const directive = yield* Ref.get(directiveRef)
        const directiveText = renderDirectiveSection(directive)
        const prompt =
          directiveText.length > 0 ? { ...base, text: base.text + directiveText } : base
        const rootHooks: AgentHooks<never> = {
          ...baseHooks,
          onTransformContext: (messages) =>
            Effect.gen(function* () {
              const inbox = yield* scopeRuntime.bus.drain(rootKey)
              return inbox.length === 0 ? messages : [...messages, ...inboxToMessages(inbox)]
            }),
        }
        const runEffect = resumeAgent(
          coderAgentConfig(deps.rootScope, scopeRuntime, prompt),
          rootCid,
          rootHooks,
          deps.cwd,
        ).pipe(
          Effect.provide(scopeRuntime.handlerLayer),
          Effect.provide(deps.approvalLayer),
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
            Effect.provide(deps.approvalLayer),
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

    // --- session summaries ---------------------------------------------------

    const rootSummary = (busy: boolean): SessionSummary => ({
      id: conversationSessionId(rootCid),
      kind: "root",
      folder: deps.cwd,
      status: busy ? "running" : "idle",
      parentId: null,
    })

    const listSummaries = (): Effect.Effect<ReadonlyArray<SessionSummary>, WorkspaceError> =>
      Effect.gen(function* () {
        const rootBusy = (yield* getRun(rootKey)).busy
        const nodes = yield* tree
          .listTree(rootCid)
          .pipe(Effect.mapError((e) => wsError(e.message)))
        const nodeSummaries: SessionSummary[] = nodes.map((n) => ({
          id: nodeSessionId(n.id),
          kind: "agent",
          ...(n.title !== undefined ? { title: n.title } : {}),
          folder: n.folder,
          status: n.status,
          parentId: n.parentId !== null ? nodeSessionId(n.parentId) : conversationSessionId(rootCid),
        }))
        return [rootSummary(rootBusy), ...nodeSummaries]
      })

    // --- the Workspace service ----------------------------------------------

    const service = Workspace.of({
      snapshot: () =>
        Effect.gen(function* () {
          const sessions = yield* listSummaries()
          const directive = yield* Ref.get(directiveRef)
          return {
            sessions,
            directive: directive ?? null,
            activeSessionId: conversationSessionId(rootCid),
          } satisfies WorkspaceSnapshot
        }),

      listSessions: () => listSummaries(),

      getState: (id) =>
        Effect.gen(function* () {
          const sessions = yield* listSummaries()
          const session = sessions.find((s) => s.id === id) ?? rootSummary(false)
          const cursor = yield* ledger.latestSeq
          const busy = (yield* getRun(id as string)).busy
          const log =
            session.kind === "root"
              ? yield* conv
                  .listActive(sessionConversationId(id))
                  .pipe(Effect.mapError((e) => wsError(e.message)))
              : yield* tree
                  .listMessages(sessionNodeId(id))
                  .pipe(Effect.mapError((e) => wsError(e.message)))
          return {
            session,
            log,
            busy,
            pendingApproval: null,
            cursor,
          } satisfies SessionState
        }),

      send: (id, prompt) =>
        Effect.gen(function* () {
          const sessions = yield* listSummaries()
          const session = sessions.find((s) => s.id === id)
          const key = id as string
          // A live session (root or agent) reads a mid-turn message from its
          // mailbox; only an idle one starts/resumes a turn.
          const running = yield* scopeRuntime.bus.isRunning(key)
          if (running) {
            const at = yield* Clock.currentTimeMillis
            yield* scopeRuntime.bus.post(key, { from: "you", content: prompt, at })
            return
          }
          if ((yield* getRun(key)).busy) {
            // Busy but no live mailbox (between turns) → queue it.
            yield* setRun(key, (s) => ({ ...s, queue: [...s.queue, prompt] }))
            return
          }
          if (session === undefined || session.kind === "root") {
            yield* startRootTurn(prompt)
          } else {
            yield* startNodeResume(sessionNodeId(id), prompt)
          }
        }).pipe(Effect.catchAllDefect((d) => Effect.fail(wsError(`send failed: ${String(d)}`)))),

      interrupt: (id) =>
        Effect.gen(function* () {
          const key = id as string
          // Root interrupt cancels the whole fleet too (Esc semantics).
          if (key === rootKey) yield* scopeRuntime.bus.interruptAll()
          else yield* scopeRuntime.bus.interrupt(key).pipe(Effect.asVoid)
          const fiber = (yield* getRun(key)).fiber
          if (fiber !== undefined) yield* Fiber.interrupt(fiber)
        }),

      spawn: (req) =>
        Effect.gen(function* () {
          const settings = yield* settingsStore.get()
          const id = deps.fleet.nextId()
          const runEffect = scopeRuntime
            .spawnAgent({
              rootConversationId: rootCid,
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
              Effect.provide(deps.approvalLayer),
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
          // The fresh node id isn't known synchronously (spawnAgent creates it
          // inside the fiber); return the root for now — clients discover the
          // node via the next `subagent_start` event / `snapshot`.
          return conversationSessionId(rootCid)
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
        deps.resolveApproval !== undefined
          ? Effect.sync(() => deps.resolveApproval!(decision))
          : Effect.fail(
              wsError(
                "approval round-trip is not wired in the in-process adapter (the client resolves approvals directly until phase e)",
              ),
            ),

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

    // Restorability: if this conversation had a turn in flight when a prior
    // daemon died, re-drive it once. Clear the marker FIRST so a crash mid-
    // resume can't loop it (the plan's retry cap, at its simplest).
    const pending = yield* conv
      .listPending(deps.cwd)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ id: ConversationId; prompt: string }>))
    if (pending.some((p) => p.id === rootCid)) {
      yield* conv.clearPending(rootCid).pipe(Effect.ignore)
      yield* startResumeTurn()
    }

    return service
  })
