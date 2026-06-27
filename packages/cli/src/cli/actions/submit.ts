import { homedir } from "node:os"
import { Cause, Clock, Effect, Queue, Schema, type Layer } from "effect"
import {
  AuthStore,
  ContextNodeId,
  ConversationStore,
  DEFAULT_AUTO_HANDOFF_PCT,
  generateSessionTitle,
  runAgent,
  runAutoDistill,
  SettingsStore,
  shouldAutoHandoff,
  type AgentDefinition,
  type AgentHooks,
  type Approval,
  type Scope,
  type Memory,
  type Skill,
  type UtilityLlm,
  inboxToMessages,
  buildScopeRuntime,
} from "@xandreed/sdk-core"
import { coderAgentConfig } from "../../usecases/coderAgentConfig.js"
import { coderPrompt } from "../../prompts/coder.js"
import { type Directive, renderDirectiveSection } from "../../usecases/directive.js"
import type { ToolDefinition } from "@xandreed/sdk-core"
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
  readonly memory: ReadonlyArray<Memory>
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
  const { store, scopeRuntime, baseHooks, eventQueue, rootScope, cwd, skills, memory, agents, tools, instructionFiles, approvalLayer, getDirective } = deps

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
        // Show the sent line in the agent's pane immediately (its log); the agent
        // reads it at its next turn boundary.
        store.appendNodeLog(nodeId, { kind: "user", text })
        store.setInput("")
        store.setNote(`delivered to running agent ${folder} — it reads at its next turn`)
        store.convScroller.current?.scrollToBottom()
        return
      }

      // The node has finished — typing resumes it in place, which owns a turn
      // (flips busy). If a turn is already running, don't start a second one on
      // the shared busy flag; queue the intent as a note instead.
      if (store.busy()) {
        store.setInput("")
        store.setNote("a turn is running — wait for it, or message a running agent")
        return
      }

      store.appendNodeLog(nodeId, { kind: "user", text })
      store.setInput("")
      store.setBusy(true)
      store.setNote(`working in agent ${folder}…`)
      store.setAgentState(submittedAgentState(Date.now()))
      store.convScroller.current?.scrollToBottom()

      const settings = yield* (yield* SettingsStore).get()

      const finishTurn = Effect.gen(function* () {
        // Take everything available (agy) — see the root finishTurn.
        const drained = store.run.dequeueAll()
        const next = drained.length > 0 ? drained.join("\n\n") : undefined
        store.setBusy(false)
        store.setNote(undefined)
        // Esc interrupts skip agent_end — settle the state machine here too.
        store.setAgentState({ ...idleAgentState, since: Date.now() })
        store.run.setFiber(undefined)
        // Re-fetch the node's session (it grew) if its preview is still open,
        // and land on the fresh tail; refresh the always-visible navigator.
        if (store.nodePreview()?.nodeId === preview.nodeId) {
          yield* openNodePreview(store, preview.nodeId, { focus: false }).pipe(
            Effect.catchAll((e) => Effect.log(`submit: preview refresh failed: ${e}`)),
          )
          store.convScroller.current?.scrollToBottom()
        }
        yield* refreshNav(store, store.run.getConversationId()).pipe(
          Effect.catchAll((e) => Effect.log(`submit: nav refresh failed: ${e}`)),
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
          // Talking to an agent is fleet plumbing, not the main conversation — a
          // resume hiccup (a vanished node, a transient failure) goes to the LOG
          // + a transient toast, never a red block in the chat. The detail lands
          // in the agent's own pane (its nodeLog) and `efferent.log`.
          Effect.catchAll((f) => {
            const msg = f.message !== undefined ? `${f.error}: ${f.message}` : f.error
            return Effect.logError(msg).pipe(
              Effect.zipRight(Effect.sync(() => store.toast(`agent ${folder}: ${f.error}`))),
            )
          }),
          // A DEFECT (untyped die) skips catchAll — without this it killed the
          // fiber with no log and a cleared spinner: the "sent a message and it
          // got stuck" shape. Log it + toast, same as any resume failure.
          Effect.catchAllDefect((d) => {
            const msg = `node resume crashed: ${String(d)}`
            return Effect.logError(msg).pipe(
              Effect.zipRight(Effect.sync(() => store.toast(`agent ${folder}: run crashed`))),
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

      // An open node-session preview routes the message to whoever you're
      // paired with — checked BEFORE the busy gate, so you can talk to a
      // teammate while the root (or anyone else) is mid-turn.
      const preview = store.nodePreview()
      if (preview !== undefined) {
        const decoded = Schema.decodeUnknownOption(ContextNodeId)(preview.nodeId)
        if (decoded._tag === "Some") {
          return yield* submitToNode(preview, decoded.value, text)
        }
      }

      // Busy and not paired with anyone? Hold the message as a pending `▸` entry
      // above the input (agy-style): it runs as the NEXT turn when the current
      // one finishes (`finishTurn` dequeues it), drained serially in order. We
      // deliberately do NOT inject it into the running turn — clean, ordered
      // turns, no surprise mid-thought steering. `↑` on an empty composer pulls
      // the last one back to edit. (Sub-agent RESULTS still auto-deliver to the
      // root via its mailbox + `onTransformContext` — a separate path, untouched.)
      if (store.busy()) {
        store.run.enqueue(text)
        store.setInput("")
        return
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
      // Optimistic user line (shown instantly): runAgent persists the message
      // and emits `user_message` with its position a beat later, which
      // reconciles onto this placeholder by key — no double line, no
      // content-hash matching.
      store.pushOptimisticUser(text)
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
      store.setTree((t) => onRunStart(t, subjectLine(text), Date.now()).tree)
      store.setBusy(true)
      // The header owns "what is the agent doing" from here — thinking until
      // the loop's first event says otherwise.
      store.setAgentState(submittedAgentState(Date.now()))

      const cid = store.run.getConversationId()

      // Reset busy + drain one queued message. Runs on success, failure, AND
      // interruption (Esc) via `ensuring`, so the loop never gets stuck.
      const finishTurn = Effect.gen(function* () {
        // Tear down the root's live mailbox. A message the human sent after the
        // loop's last turn boundary (so the loop never drained it) is requeued
        // here so it isn't lost; agent completion notes are not — they're in
        // :tree and each agent's preview.
        const leftover = yield* scopeRuntime.bus.drain(cid)
        yield* scopeRuntime.bus.markDone(cid)
        for (const m of leftover) if (m.from === "you") store.run.enqueue(m.content)
        // Take EVERYTHING available (agy): drain the whole pending queue into the
        // next turn at once — not one-per-turn, which left later messages waiting
        // in the `▸` list across several turns ("only one drains, the rest hang").
        // All pending entries clear immediately and run together as one turn.
        const drained = store.run.dequeueAll()
        const next = drained.length > 0 ? drained.join("\n\n") : undefined
        store.setBusy(false)
        store.setNote(undefined)
        // Esc interrupts skip agent_end — settle the state machine here too.
        store.setAgentState({ ...idleAgentState, since: Date.now() })
        store.run.setFiber(undefined)
        // Seal the Activity run container (closes any still-open descendants
        // too — an interrupt skips their end events).
        store.setTree((t) => onRunEnd(t, true, Date.now()))
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
        yield* refreshNav(store, cid).pipe(Effect.catchAll((e) => Effect.log(`submit: nav refresh failed: ${e}`)))
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
        // Learn for next runs: at the turn boundary, mine this conversation for
        // reusable skills/constraints (cheap fast tier), Opus-verify each, and
        // persist the survivors so future runs inherit them. Background daemon +
        // fail-soft — never blocks the UI, and a missing claude / provider just
        // means nothing is learned this turn. Skipped while messages are queued.
        if (next === undefined && settings.autoDistill !== false) {
          const existing = [
            ...skills.map((s) => s.name),
            ...memory.map((m) => m.name),
          ]
          const distillEffect = runAutoDistill({
            conversationId: cid,
            repoDir: cwd,
            globalDir: homedir(),
            existing,
          }).pipe(
            Effect.flatMap((saved) =>
              saved.length === 0
                ? Effect.void
                : Effect.sync(() =>
                    store.pushBlock({
                      kind: "info",
                      text: `learned ${saved.length} reusable ${saved.length === 1 ? "lesson" : "lessons"} for next time: ${saved.map((r) => r.candidate.name).join(", ")} (:set autoDistill off to disable)`,
                    }),
                  ),
            ),
            Effect.catchAll((e) => Effect.log(`auto-distill failed: ${e}`)),
          )
          yield* Effect.forkDaemon(distillEffect)
        }
        if (next !== undefined) yield* submit(next)
      })

      // Append the session's standing goal (if any) so it rides every turn.
      const base = coderPrompt(cwd, new Date(), skills, instructionFiles, agents, tools, undefined, memory)
      const directiveText = renderDirectiveSection(getDirective())
      const prompt =
        directiveText.length > 0 ? { ...base, text: base.text + directiveText } : base
      // Give the root an inbox like every other agent: a message sent to it
      // mid-turn (busy → bus.post(cid)) is folded in at the next turn boundary,
      // so the human can steer the lead without waiting for the turn to end.
      const rootHooks: AgentHooks<never> = {
        ...baseHooks,
        onTransformContext: (messages) =>
          Effect.gen(function* () {
            const inbox = yield* scopeRuntime.bus.drain(cid)
            return inbox.length === 0 ? messages : [...messages, ...inboxToMessages(inbox)]
          }),
      }
      const runEffect = runAgent(
        coderAgentConfig(rootScope, scopeRuntime, prompt),
        cid,
        text,
        rootHooks,
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

      // Open the root's mailbox just before the run starts; finishTurn closes it.
      yield* scopeRuntime.bus.markRunning(cid, "you")
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
