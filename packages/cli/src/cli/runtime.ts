import { homedir } from "node:os"
import { join } from "node:path"
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent } from "solid-js"
import { Clock, Deferred, Effect, Fiber, Queue, Runtime, Schema } from "effect"
import {
  AuthStore,
  connLabel,
  ConversationId,
  LlmInfo,
  ModelRegistry,
  SettingsStore,
  Shell,
  StoreSwitch,
  TerminalSession,
  buildScopeRuntime,
} from "@xandreed/sdk-core"
import { importAgentsFromGithub, importToolsFromGithub } from "../usecases/importAgents.js"
import type { TuiModeInput } from "../modes/tui.js"
import { makeEventHooks, type AgentEvent } from "../events.js"
import { fileLoggerLayer } from "./presentation/logger.js"
import { rolesReadout } from "./presentation/statusBar.js"
import { emptySidePane, emptyStats, type SidePaneState } from "./presentation/sidePane.js"
import { App } from "./view/App.js"
import { treeSitterClient } from "./view/syntax.js"
import { makeTuiApproval } from "./approval.js"
import { stopOAuthSession } from "./actions/login.js"
import { makeSubmit } from "./actions/submit.js"
import { makeSpawnAgent } from "./actions/spawnAgent.js"
import { makeFleetSupervisor } from "./state/fleet.js"
import type { Directive } from "../usecases/directive.js"
import {
  cronMatches,
  loadJobs,
  markJobRun,
  minuteBucket,
  parseCron,
} from "@xandreed/sdk-core"
import { refreshNav } from "./actions/contextTree.js"
import { loadInitialConversation, openConversationPicker } from "./actions/session.js"
import { openOnboardingFlow } from "./actions/onboarding.js"
import { makeEventReducer, runEventPump } from "./events/eventPump.js"
import { createTuiStore, type AppServices, type TuiContext } from "./state/store.js"
import { setTheme } from "./state/theme.js"

// Honors EFFERENT_HOME like every other config-dir consumer (auth.json, the
// SQLite default) — relocating the home must relocate the log too.
const logFilePath = (): string =>
  join(process.env.EFFERENT_HOME ?? join(homedir(), ".efferent"), "efferent.log")

const decodeConversationId = Schema.decodeUnknown(ConversationId)
const newConversationId = (): ConversationId =>
  Effect.runSync(decodeConversationId(crypto.randomUUID()).pipe(Effect.orDie))

/**
 * The Solid/OpenTUI TUI driver — a drop-in for the old `runTuiMode` (same
 * `TuiModeInput`, same `AppServices` R-channel). It is the single place the
 * three runtimes meet:
 *
 *   • Effect owns the domain services + the agent fiber. We capture the runtime
 *     (`Effect.runtime`, exactly as `tui.ts:3558`) so Solid handlers can run
 *     domain effects via `ctx.run`.
 *   • Solid owns UI state (the signal store) and the view (mounted with
 *     `render`). Its only inbound channel is the event pump.
 *   • OpenTUI owns layout + the render loop + the terminal. We wrap the renderer
 *     in `acquireRelease`, so the alt-screen / raw mode / mouse are restored on
 *     success, failure, AND interruption (the `BunRuntime.runMain` signal path).
 *
 * Crossings are strictly one-directional: `ctx.run`/`ctx.submit` (UI→Effect)
 * and the forked event pump (Effect→signals). The agent fiber handle lives in
 * the store's non-reactive `run` slot, never on the signal graph.
 */
export const runTuiModeSolid = (
  input: TuiModeInput,
): Effect.Effect<void, never, AppServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      // 1. Initial model / settings snapshot for the status bar.
      const info = yield* LlmInfo
      const meta = yield* info.metadata
      const registry = yield* ModelRegistry
      const sel = yield* registry.current
      const settings = yield* (yield* SettingsStore).get()
      // Seed the active colour theme from config before the first render (an
      // unknown / absent name leaves the default). `:theme` switches it live.
      if (settings.theme !== undefined) setTheme(settings.theme)
      const effort =
        sel.provider === "anthropic"
          ? settings.anthropicThinkingEffort
          : sel.provider === "openai"
            ? settings.openAiReasoningEffort
            : sel.provider === "google"
              ? settings.geminiThinkingLevel
              : undefined

      const cid =
        input.resumeConversationId !== undefined
          ? yield* decodeConversationId(input.resumeConversationId).pipe(Effect.orDie)
          : newConversationId()

      // 2. Agent event plumbing: queue → hooks → scope runtime (allows bash;
      //    `baseHooks` so delegation emits subagent events onto the queue).
      const eventQueue = yield* Queue.unbounded<AgentEvent>()
      const baseHooks = makeEventHooks(eventQueue)
      const scopeRuntime = buildScopeRuntime(
        input.rootScope,
        { skills: input.skills, memory: input.memory, agents: input.agents, tools: input.tools, allowBash: true },
        baseHooks,
      )

      // 3. Capture the runtime — the UI→Effect bridge.
      const rt = yield* Effect.runtime<AppServices>()

      // 4. UI state + lifted actions + the event reducer. The side pane is seeded
      //    like the old `seedSidePane`: discovered skills + instruction files, and
      //    the stats' context window + session start.
      const sidePane: SidePaneState = {
        ...emptySidePane,
        // Chat-first: the right pane is always the fleet tree, so pin the side
        // nav's view to "tree" from boot (it drives the tree cursor/folds).
        view: "tree",
        skillsLoaded: input.skills.map((s) => s.name),
        instructions: input.instructionFiles.map((f) => ({ path: f.path, scope: f.path })),
        stats: { ...emptyStats, startedAt: Date.now(), contextWindow: meta.contextWindow },
      }
      // The active database (name + kind) for the status bar — read from the
      // switchable store so it reflects the connection actually built at boot.
      const activeDb = yield* (yield* StoreSwitch).current
      const store = createTuiStore({
        status: {
          modelId: meta.modelId,
          cwd: input.cwd,
          storage: connLabel(activeDb.name, activeDb.kind),
          effort,
          roles: rolesReadout(settings),
        },
        conversationId: cid,
        // Not a permanent footer row — log path on demand.
        footer: `logs: tail -f ${logFilePath()}`,
        sidePane,
      })
      // Boot conversation handling: onboarding is gated SOLELY on whether a
      // usable credential exists (merged global ∪ local). A credential is the
      // real "set up" signal — the model always has a default — so a global
      // login covers every workspace (once per machine), and no per-folder
      // `config.json` can re-trigger or suppress onboarding.
      const authAll = yield* (yield* AuthStore).all
      const hasCreds = Object.keys(authAll).length > 0

      if (!hasCreds) {
        yield* openOnboardingFlow(store)
      } else if (input.resumeConversationId !== undefined) {
        yield* loadInitialConversation(store, cid)
      } else {
        // First contact: one line that teaches the three interactions that
        // unlock everything else. Only on a fresh session — a resumed rail
        // speaks for itself.
        store.pushBlock({
          kind: "info",
          text: "type to chat (↵ sends) · : for commands · ? for keys",
        })
        yield* openConversationPicker(store, input.cwd)
      }

      // The bin's chrome variant (presentation only). The fleet pane is
      // current-session-only in BOTH bins now — one always-expanded root (the
      // working session) and its agent subtree; other sessions live in the
      // `:browse`/resume picker, not this always-visible pane.
      const variant = input.variant ?? "master"
      const navOpts = { activeOnly: true }

      // The fleet tree is always visible — seed it at boot so the current
      // session's sub-agents show without `:tree`.
      yield* refreshNav(store, cid, navOpts).pipe(Effect.catchAll(() => Effect.void))

      // Interactive bash approval: the agent fiber suspends on the Approval
      // port; the modal's keys answer through `ctx.resolveApproval`.
      const approval = makeTuiApproval(store)

      const submit = makeSubmit({
        store,
        scopeRuntime,
        baseHooks,
        eventQueue,
        rootScope: input.rootScope,
        cwd: input.cwd,
        skills: input.skills,
        memory: input.memory,
        agents: input.agents,
        tools: input.tools,
        instructionFiles: input.instructionFiles,
        approvalLayer: approval.layer,
        getDirective: () => directiveRef.current,
      })

      // The live fleet: detached fired agents (`:spawn`), held so `:stop` can
      // cancel one. The persistent tree (`:tree`) is the durable view.
      const fleet = makeFleetSupervisor()
      const spawnAgentAction = makeSpawnAgent({
        store,
        scopeRuntime,
        eventQueue,
        approvalLayer: approval.layer,
        fleet,
      })

      // The session's standing goal (Phase 4): held in the runtime closure
      // (session-scoped — persisting across resume is a follow-up), injected into
      // every turn's prompt by `submit`, and checked by the built-in verifier role.
      const directiveRef: { current: Directive | undefined } = { current: undefined }
      const reduce = makeEventReducer(store, {
        // Live navigator reload on sub-agent spawn/end (current session — it
        // can change via the sessions view, so resolve the id per call).
        refreshNav: () => {
          Runtime.runFork(rt)(
            refreshNav(store, store.run.getConversationId(), navOpts).pipe(
              Effect.catchAll(() => Effect.void),
            ),
          )
        },
      })

      // 5. Exit signal + the context the JSX consumes.
      const exitDeferred = yield* Deferred.make<void>()
      const ctx: TuiContext = {
        store,
        // The bin's chrome variant (`code` forces this driver + "code"); the
        // remote driver is always "master". Default "master" if unset.
        variant: input.variant ?? "master",
        run: (program) => Runtime.runPromise(rt)(program),
        submit: (text) => {
          void Runtime.runPromise(rt)(submit(text))
        },
        interrupt: () => {
          // Esc cancels EVERYTHING in flight: the root turn AND every background
          // fleet agent (spawning is non-blocking, so the fleet are daemons the
          // root fiber no longer encloses — interrupt them explicitly, no orphans).
          Runtime.runFork(rt)(scopeRuntime.bus.interruptAll())
          const fiber = store.run.getFiber()
          if (fiber !== undefined) Runtime.runFork(rt)(Fiber.interrupt(fiber))
        },
        newConversation: () => {
          // In-process: the conversation id is local; the next submit reads it
          // (`store.run.getConversationId()`) and `runAgent` materialises it. The
          // rail was already reset by `:clear`.
          store.run.newConversation(newConversationId())
          store.pushBlock({
            kind: "info",
            text: `new conversation: ${store.run.getConversationId().slice(0, 8)}`,
          })
        },
        clearQueue: () => {
          // In-process owns its queue directly — drop the pending messages.
          store.run.dequeueAll()
        },
        roles: input.agents,
        tools: input.tools,
        spawnAgent: (agent, folder, task) => {
          void Runtime.runPromise(rt)(spawnAgentAction({ agent, folder, task }))
        },
        stopAgent: (id) => {
          const entry = fleet.get(id)
          if (entry !== undefined) Runtime.runFork(rt)(Fiber.interrupt(entry.fiber))
        },
        listFleet: () =>
          fleet.list().map((e) => ({ id: e.id, title: e.title, folder: e.folder })),
        liveAgents: () =>
          // Synchronous read of the bus's running map (pure Ref.get). Drop the
          // root session's own mailbox key — it's the human, not a fleet agent.
          Runtime.runSync(rt)(scopeRuntime.bus.listRunning()).filter(
            (a) => a.nodeId !== store.run.getConversationId(),
          ),
        getDirective: () => directiveRef.current,
        setDirective: (d) => {
          directiveRef.current = d
        },
        importAgents: (spec) => {
          void Runtime.runPromise(rt)(
            Effect.gen(function* () {
              store.pushBlock({ kind: "info", text: `importing agents from ${spec}…` })
              const res = yield* importAgentsFromGithub(
                spec,
                join(input.cwd, ".efferent/agents"),
              )
              const parts: Array<string> = []
              if (res.written.length > 0) parts.push(`imported ${res.written.join(", ")}`)
              if (res.skipped.length > 0) parts.push(`skipped — ${res.skipped.join("; ")}`)
              store.pushBlock({
                kind: "info",
                text: `${parts.join(" · ") || "nothing imported"} (applies on next launch)`,
              })
            }).pipe(
              Effect.catchAll((e) =>
                Effect.sync(() =>
                  store.pushBlock({ kind: "error", text: `import failed: ${e.message}` }),
                ),
              ),
            ),
          )
        },
        importTools: (spec) => {
          void Runtime.runPromise(rt)(
            Effect.gen(function* () {
              store.pushBlock({ kind: "info", text: `importing tools from ${spec}…` })
              const res = yield* importToolsFromGithub(spec, join(input.cwd, ".efferent/tools"))
              const parts: Array<string> = []
              if (res.written.length > 0) parts.push(`imported ${res.written.join(", ")}`)
              if (res.skipped.length > 0) parts.push(`skipped — ${res.skipped.join("; ")}`)
              store.pushBlock({
                kind: "info",
                text: `${parts.join(" · ") || "nothing imported"} (applies on next launch)`,
              })
            }).pipe(
              Effect.catchAll((e) =>
                Effect.sync(() =>
                  store.pushBlock({ kind: "error", text: `import failed: ${e.message}` }),
                ),
              ),
            ),
          )
        },
        exit: () => {
          Runtime.runFork(rt)(Deferred.succeed(exitDeferred, undefined))
        },
        copySelection: () => {
          const text = renderer.getSelection()?.getSelectedText() ?? ""
          if (text.length === 0) return false
          renderer.copyToClipboardOSC52(text)
          store.toast(`copied ${text.length} chars to clipboard`)
          return true
        },
        resolveApproval: approval.resolve,
      }

      // 6-pre. Exit feedback. Registered BEFORE the renderer, so it runs AFTER
      //    the renderer's destroy (finalizers run in reverse): by then the alt
      //    screen is gone and this lands on the user's real terminal, while the
      //    rest of teardown (worker, DB, logger layers, event-loop drain) still
      //    runs — a visible beat instead of a silent freeze if it ever stalls.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => process.stderr.write("efferent: cleaning up…\n")),
      )

      // 6. Renderer — owns alt-screen / raw mode / mouse / render loop. No
      //    exitOnCtrlC or exitSignals: we drive exit through `exitDeferred`, and
      //    the scope finalizer (below) restores the terminal on every path.
      const renderer = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createCliRenderer({
            exitOnCtrlC: false,
            exitSignals: [],
            useMouse: true,
            targetFps: 30,
          }),
        ),
        (r) => Effect.sync(() => r.destroy()),
      )

      // 6b. Tree-sitter highlight worker (syntax colouring of code blocks + diff
      //     hunks) is a singleton in @opentui/core that lazily spawns a Worker on
      //     first highlight. That Worker keeps Bun alive, so we MUST terminate it
      //     on every exit path — destroy() is a no-op if it never started.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => treeSitterClient()?.destroy() ?? Promise.resolve()).pipe(
          Effect.ignore,
        ),
      )

      // 6c. A `:login` OAuth flow the user started but never finished in the
      //     browser leaves its callback server listening — and since a clean
      //     exit waits for the event loop to drain (runMain doesn't hard-exit
      //     on code 0), that listener would hold the process open forever.
      //     The overlay's Esc/Ctrl-C cancel paths already stop it; this covers
      //     the forgotten one. No-op when no login is in flight.
      yield* Effect.addFinalizer(() => stopOAuthSession(store).pipe(Effect.ignore))

      // 6d. Background fleet agents are daemons (non-blocking spawning) — they'd
      //     keep Bun alive past exit. Interrupt the whole fleet on every teardown
      //     path so the process can quit cleanly. No-op when nothing is running.
      yield* Effect.addFinalizer(() => scopeRuntime.bus.interruptAll().pipe(Effect.ignore))

      // 6e. Background shell processes (Bash run_in_background) + tmux sessions are
      //     DETACHED — they outlive turns on purpose, but must not outlive the app.
      //     Group-kill them all on exit so no dev server / watcher / pane is orphaned.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* (yield* Shell).killAllBackground()
          yield* (yield* TerminalSession).killAll()
        }).pipe(Effect.ignore),
      )

      // 7. Drain the agent event queue into the signal store (scoped fiber).
      yield* Effect.forkScoped(runEventPump(eventQueue, reduce))

      // 7b. Spinner ticker — advances running tree-node glyphs while a turn is in
      //     flight (no signal write when idle → no idle re-renders). Scoped.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sync(() => {
            // Animate while the agent is doing anything visible: a turn in flight
            // (phase ≠ idle) OR a background fleet still working (the root can be
            // idle while its agents keep going). Gate on the PHASE machine, not
            // `busy()` — `busy()` is only set on the in-process path, so a
            // `busy()` gate freezes the spinner on the remote/daemon path where
            // the phase is the sole live signal. Phase covers both bins.
            const st = store.agentState()
            if (st.phase !== "idle" || st.fleet.length > 0) store.tickSpinner()
          }).pipe(Effect.delay("120 millis")),
        ),
      )

      // 7c. Cron tick (Phase 5) — once a minute, fire this workspace's due
      //     scheduled jobs as detached agents. File-backed job list; the tick
      //     runs only while the TUI is up (a headless daemon is the Phase 7
      //     follow-up). Fires at most once per matching minute (minuteBucket).
      const tickScheduler = Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        const now = new Date(nowMs)
        const jobs = yield* loadJobs()
        for (const job of jobs) {
          if (job.cwd !== input.cwd) continue
          const fields = parseCron(job.cron)
          if (fields === undefined || !cronMatches(fields, now)) continue
          if (job.lastRunMs !== undefined && minuteBucket(job.lastRunMs) === minuteBucket(nowMs)) {
            continue
          }
          yield* markJobRun(job.id, nowMs)
          store.pushBlock({ kind: "info", text: `⏰ scheduled job fired (${job.cron}): ${job.prompt}` })
          yield* Effect.forkDaemon(
            scopeRuntime
              .spawnAgent({
                rootConversationId: store.run.getConversationId(),
                folder: job.folder,
                task: job.prompt,
                title: `scheduled: ${job.prompt.slice(0, 30)}`,
                ...(job.agent !== undefined ? { agent: job.agent } : {}),
              })
              .pipe(Effect.provide(approval.layer), Effect.ignore),
          )
        }
      }).pipe(Effect.catchAll(() => Effect.void))
      yield* Effect.forkScoped(
        Effect.forever(tickScheduler.pipe(Effect.delay("60 seconds"))),
      )

      // 8. Mount Solid. `createComponent` avoids JSX in this `.ts` driver.
      yield* Effect.promise(() => render(() => createComponent(App, { ctx }), renderer))

      // 9. Block until exit; scope finalizers then restore the terminal.
      yield* Deferred.await(exitDeferred)
    }),
  ).pipe(
    Effect.provide(fileLoggerLayer(logFilePath())),
  ) as Effect.Effect<void, never, AppServices>
