import { Cause, Clock, Effect, Queue, Schema, type Layer } from "effect"
import {
  AuthStore,
  ContextNodeId,
  ConversationStore,
  DEFAULT_AUTO_HANDOFF_PCT,
  generateSessionTitle,
  runAgent,
  SettingsStore,
  shouldAutoHandoff,
  type AgentDefinition,
  type AgentHooks,
  type Approval,
  type Scope,
  type Skill,
  type UtilityLlm,
} from "@xandreed/sdk-core"
import { buildScopeRuntime } from "../../usecases/buildScopeRuntime.js"
import { coderAgentConfig } from "../../usecases/coderAgentConfig.js"
import { coderPrompt } from "../../prompts/coder.js"
import { type Directive, renderDirectiveSection } from "../../usecases/directive.js"
import type { ToolDefinition } from "../../usecases/loadTools.js"
import { type InstructionFile } from "../../usecases/discoverInstructionFiles.js"
import type { AgentEvent } from "../../events.js"
import { formatFullError, inspectError } from "../util/errorFormat.js"
import { idleAgentState, submittedAgentState } from "../presentation/agentState.js"
import { buildConversation, subjectLine } from "../presentation/conversation.js"
import { onRunEnd, onRunStart } from "../presentation/executionTree.js"
import { accumulateRoleSpend } from "../presentation/sidePane.js"
import { contextPercent } from "../presentation/statusBar.js"
import { runHandoff } from "./handoff.js"
import type { NodePreview } from "../presentation/nodePreview.js"
import { openNodePreview, refreshNav } from "./contextTree.js"
import type { AppServices, TuiStore } from "../state/store.js"

/**
 * Pull the most-recently queued message back into the composer for editing —
 * the agy "Press up to edit queued messages" gesture, wired to `↑` on an empty
 * input (`keys/dispatch.ts:inputKey`). A no-op when nothing is queued.
 */
export const editLastQueued = (store: TuiStore): void => {
  const text = store.run.popQueued()
  if (text === undefined) return
  store.inputControl.current?.seed(text)
  store.setFocus("input")
  store.setMode("insert")
}

export interface SubmitDeps {
  readonly store: TuiStore
  readonly scopeRuntime: ReturnType<typeof buildScopeRuntime>
  readonly baseHooks: AgentHooks<never>
  readonly eventQueue: Queue.Queue<AgentEvent>
  readonly rootScope: Scope
  readonly cwd: string
  readonly skills: ReadonlyArray<Skill>
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly instructionFiles: ReadonlyArray<InstructionFile>
  /** The TUI's interactive Approval impl — satisfies the bash handler's ask. */
  readonly approvalLayer: Layer.Layer<Approval, never, SettingsStore | UtilityLlm>
  /** The session's standing goal (Phase 4), read per turn and appended to the
   *  prompt. Returns undefined when none is set. */
  readonly getDirective: () => Directive | undefined
}

/**
 * The agent-run action, lifted from `tui.ts:1442` (`submit`). The Effect body is
 * unchanged in spirit — auth gate, busy→queue, fork `runAgent` with the scope's
 * handler layer, drain the queue in an `ensuring` `finishTurn` — but every UI
 * write goes through the Solid store instead of `Ref.update(stateRef)`. The
 * agent fiber stays Effect-owned (`store.run.getFiber()`), never a signal.
 *
 * Returns a recursive `submit` so a queued message resubmits on turn end.
 */
export const makeSubmit = (
  deps: SubmitDeps,
): ((text: string) => Effect.Effect<void, never, AppServices>) => {
  const { store, scopeRuntime, baseHooks, eventQueue, rootScope, cwd, skills, agents, tools, instructionFiles, approvalLayer, getDirective } = deps

  /**
   * Follow-up typed while a node-session preview is open: the message goes to
   * THAT sub-agent, not the active conversation — `scopeRuntime.resumeNode`
   * appends it to the node's persisted context and re-runs the folder-scoped
   * loop in place. The preview shows the sent line immediately and re-fetches
   * the node's messages when the run ends (success, failure, or Esc).
   */
  const submitToNode = (
    preview: NodePreview,
    nodeId: typeof ContextNodeId.Type,
    text: string,
  ): Effect.Effect<void, never, AppServices> =>
    Effect.gen(function* () {
      const folder = preview.title.replace(/^agent: /, "")

      // If this node is a LIVE fiber, deliver to its mailbox — it reads the
      // message at its next turn boundary — instead of resuming a finished node.
      // The composer stays free (no busy flip); the agent keeps running.
      const live = yield* scopeRuntime.bus.isRunning(nodeId)
      if (live) {
        const at = yield* Clock.currentTimeMillis
        yield* scopeRuntime.bus.post(nodeId, { from: "you", content: text, at })
        store.setNodePreview({
          ...preview,
          blocks: [...preview.blocks, { kind: "user", text }],
        })
        store.setInput("")
        store.setNote(`delivered to running agent ${folder} — it reads at its next turn`)
        store.convScroller.current?.scrollToBottom()
        return
      }

      store.setNodePreview({
        ...preview,
        blocks: [...preview.blocks, { kind: "user", text }],
      })
      store.setInput("")
      store.setBusy(true)
      store.setNote(`working in agent ${folder}…`)
      store.setAgentState(submittedAgentState(Date.now()))
      store.convScroller.current?.scrollToBottom()

      const settings = yield* (yield* SettingsStore).get()

      const finishTurn = Effect.gen(function* () {
        const next = store.run.dequeue()
        store.setBusy(false)
        store.setNote(undefined)
        // Esc interrupts skip agent_end — settle the state machine here too.
        store.setAgentState({ ...idleAgentState, since: Date.now() })
        store.run.setFiber(undefined)
        // Re-fetch the node's session (it grew) if its preview is still open,
        // and land on the fresh tail; refresh the always-visible navigator.
        if (store.nodePreview()?.nodeId === preview.nodeId) {
          yield* openNodePreview(store, preview.nodeId, { focus: false }).pipe(
            Effect.catchAll(() => Effect.void),
          )
          store.convScroller.current?.scrollToBottom()
        }
        yield* refreshNav(store, store.run.getConversationId()).pipe(
          Effect.catchAll(() => Effect.void),
        )
        if (next !== undefined) yield* submit(next)
      })

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
          Effect.catchAll((f) => {
            const msg = f.message !== undefined ? `${f.error}: ${f.message}` : f.error
            return Effect.logError(msg).pipe(
              Effect.zipRight(Queue.offer(eventQueue, { type: "error", message: msg })),
            )
          }),
          // A DEFECT (untyped die) skips catchAll — without this it killed the
          // fiber with no log, no error block, and a cleared spinner: the exact
          // "sent a message and it got stuck" shape. Surface it like any error.
          Effect.catchAllDefect((d) => {
            const msg = `node resume crashed: ${String(d)}`
            return Effect.logError(msg).pipe(
              Effect.zipRight(Queue.offer(eventQueue, { type: "error", message: msg })),
            )
          }),
          Effect.asVoid,
          Effect.ensuring(finishTurn),
        )

      const fiber = yield* Effect.forkDaemon(runEffect)
      store.run.setFiber(fiber)
    })

  const submit = (text: string): Effect.Effect<void, never, AppServices> =>
    Effect.gen(function* () {
      // No provider configured → guide to :login instead of a deep 401.
      const authAll = yield* (yield* AuthStore).all
      if (Object.keys(authAll).length === 0) {
        store.pushBlock({ kind: "user", text })
        store.pushBlock({
          kind: "info",
          text: "no provider configured — run :login to add one (subscription or API key)",
        })
        store.setInput("")
        store.convScroller.current?.scrollToBottom()
        return
      }

      // Busy → queue it for after the current turn. The pending queue is now
      // shown as a `▸ …` list above the input (and the status hint flips to
      // `↑ to edit queued`), so no transient toast is needed.
      if (store.busy()) {
        store.run.enqueue(text)
        store.setInput("")
        return
      }

      // An open node-session preview routes the message to that sub-agent.
      const preview = store.nodePreview()
      if (preview !== undefined) {
        const decoded = Schema.decodeUnknownOption(ContextNodeId)(preview.nodeId)
        if (decoded._tag === "Some") {
          return yield* submitToNode(preview, decoded.value, text)
        }
      }

      // Rail rhythm (opt-in, `:set autoCollapse on`): every turn existing
      // BEFORE this message folds to `❯ subject ▸ N steps`, so the new one —
      // expanded, its running tool group showing live pills — is the only
      // expanded story on screen. Off by default: turns stay as you left them.
      // (Computed before the push so the fresh turn itself stays open.)
      const autoCollapse = (yield* (yield* SettingsStore).get()).autoCollapse === true
      const prevTurns = buildConversation(store.blocks())
        .filter((i) => i.kind === "turn")
        .map((i) => i.id)
      // No prior turns ⇒ this message opens the session — worth naming.
      const firstExchange = prevTurns.length === 0
      if (autoCollapse && prevTurns.length > 0) {
        store.setCollapsed(new Set([...store.collapsed(), ...prevTurns]))
      }
      store.pushBlock({ kind: "user", text })
      store.setInput("")
      // Sending snaps the rail to the bottom even if the user had scrolled up
      // to read (which disengages sticky-follow): your own message — and the
      // reply about to stream under it — is always brought into view.
      store.convScroller.current?.scrollToBottom()
      // Activity: fold the previous runs' roots (this message starts a new
      // story — the old ones compress to one line each) and open a fresh run
      // container labelled with the prompt; the loop's turns nest under it.
      const prevRoots = store
        .projection()
        .tree.roots.filter((r) => r.kind === "run" || r.kind === "turn")
      if (prevRoots.length > 0) {
        store.setNav((n) => ({
          ...n,
          stackCollapsed: new Set([
            ...n.stackCollapsed,
            ...prevRoots.map((r) => `node:${r.id}`),
          ]),
        }))
      }
      store.setProjection((p) => ({
        ...p,
        tree: onRunStart(p.tree, subjectLine(text), Date.now()).tree,
      }))
      store.setBusy(true)
      // The header owns "what is the agent doing" from here — thinking until
      // the loop's first event says otherwise.
      store.setAgentState(submittedAgentState(Date.now()))

      const cid = store.run.getConversationId()

      // Reset busy + drain one queued message. Runs on success, failure, AND
      // interruption (Esc) via `ensuring`, so the loop never gets stuck.
      const finishTurn = Effect.gen(function* () {
        const next = store.run.dequeue()
        store.setBusy(false)
        store.setNote(undefined)
        // Esc interrupts skip agent_end — settle the state machine here too.
        store.setAgentState({ ...idleAgentState, since: Date.now() })
        store.run.setFiber(undefined)
        // Seal the Activity run container (closes any still-open descendants
        // too — an interrupt skips their end events).
        store.setProjection((p) => ({ ...p, tree: onRunEnd(p.tree, true, Date.now()) }))
        // The session's first exchange just landed: name it on the fast
        // helper tier, off the critical path. Best-effort daemon — a missing
        // credential / provider hiccup must never surface here.
        if (firstExchange) {
          yield* Effect.forkDaemon(
            Effect.gen(function* () {
              const cs = yield* ConversationStore
              const history = yield* cs.list(cid)
              const res = yield* generateSessionTitle(history)
              // The fast tier's spend is real spend — count it.
              if (res.usage !== undefined) {
                const u = res.usage
                store.setStats((s) =>
                  accumulateRoleSpend(s, "fast", u.inputTokens + u.outputTokens),
                )
              }
              if (res.title.length === 0) return
              yield* cs.setTitle(cid, res.title)
              yield* refreshNav(store, cid)
            }).pipe(Effect.ignore),
          )
        }
        // Refresh the always-visible navigator — a run may have spawned or
        // updated sub-agent nodes. Best-effort; a store hiccup never blocks.
        yield* refreshNav(store, cid).pipe(Effect.catchAll(() => Effect.void))
        // Compaction: fold at the boundary. When the last turn's context crossed
        // the threshold, run the handoff fold NOW — one deliberate prefix
        // rebuild (the only cache-safe way to shrink history), then the cache
        // is warm again. Skipped while messages are queued (fold once the
        // queue drains) and on resume estimates (a chars/4 guess must not
        // trigger a surprise fold — the first real turn decides).
        const settings = yield* (yield* SettingsStore).get()
        const st = store.stats()
        const pct = settings.autoHandoffPct ?? DEFAULT_AUTO_HANDOFF_PCT
        if (
          next === undefined &&
          st.estimated !== true &&
          shouldAutoHandoff(st.inputTokens, st.contextWindow, pct)
        ) {
          store.pushBlock({
            kind: "info",
            text: `context at ${contextPercent(st.inputTokens, st.contextWindow)}% of the window — auto-folding via handoff (:set autoHandoffPct 0 to disable)`,
          })
          yield* runHandoff(store, cid).pipe(Effect.catchAll(() => Effect.void))
        }
        if (next !== undefined) yield* submit(next)
      })

      // Append the session's standing goal (if any) so it rides every turn.
      const base = coderPrompt(cwd, new Date(), skills, instructionFiles, agents, tools)
      const directiveText = renderDirectiveSection(getDirective())
      const prompt =
        directiveText.length > 0 ? { ...base, text: base.text + directiveText } : base
      const runEffect = runAgent(
        coderAgentConfig(rootScope, scopeRuntime, prompt),
        cid,
        text,
        baseHooks,
        cwd,
      ).pipe(
        Effect.provide(scopeRuntime.handlerLayer),
        // Approval provided AFTER the handler layer so it satisfies both the
        // root build above and the nested child-handler builds that resolve
        // it from the running fiber's context during run_agent spawns.
        Effect.provide(approvalLayer),
        Effect.catchAll((err) =>
          // Full nested detail to the log file; a compact, secret-free,
          // actionable line to the rail (an inspect-dump here once flooded the
          // conversation pane and leaked the bearer token).
          Effect.logError(inspectError(err)).pipe(
            Effect.zipRight(
              Queue.offer(eventQueue, { type: "error", message: formatFullError(err) }),
            ),
          ),
        ),
        Effect.catchAllDefect((d) => {
          const msg = `agent run crashed: ${String(d)}`
          return Effect.logError(msg).pipe(
            Effect.zipRight(Queue.offer(eventQueue, { type: "error", message: msg })),
          )
        }),
        Effect.asVoid,
        Effect.ensuring(finishTurn),
      )

      const fiber = yield* Effect.forkDaemon(runEffect)
      store.run.setFiber(fiber)
    }).pipe(
      // The caller void-discards the promise (`ctx.submit`), so a defect in
      // the pre-fork section (gates, routing, settings read) would otherwise
      // vanish without a trace. Make it loud and reset the busy state.
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          store.setBusy(false)
          store.setNote(undefined)
          store.pushBlock({ kind: "error", text: `submit crashed: ${Cause.pretty(cause)}` })
        }).pipe(Effect.zipRight(Effect.logError(Cause.pretty(cause)))),
      ),
    )

  return submit
}
