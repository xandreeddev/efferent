import { homedir } from "node:os"
import { join } from "node:path"
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent } from "solid-js"
import { Deferred, Effect, Fiber, Queue, Runtime, Schema } from "effect"
import {
  AuthStore,
  ConversationId,
  LlmInfo,
  ModelRegistry,
  SettingsStore,
} from "@xandreed/sdk-core"
import { buildScopeRuntime } from "../usecases/buildScopeRuntime.js"
import type { TuiModeInput } from "../modes/tui.js"
import { makeEventHooks, type AgentEvent } from "../events.js"
import { fileLoggerLayer } from "./presentation/logger.js"
import { storageLabel } from "./presentation/dbStatus.js"
import { rolesChip } from "./presentation/statusBar.js"
import { emptySidePane, emptyStats, type SidePaneState } from "./presentation/sidePane.js"
import { App } from "./view/App.js"
import { treeSitterClient } from "./view/syntax.js"
import { makeTuiApproval } from "./approval.js"
import { stopOAuthSession } from "./actions/login.js"
import { makeSubmit } from "./actions/submit.js"
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
        { skills: input.skills, allowBash: true },
        baseHooks,
      )

      // 3. Capture the runtime — the UI→Effect bridge.
      const rt = yield* Effect.runtime<AppServices>()

      // 4. UI state + lifted actions + the event reducer. The side pane is seeded
      //    like the old `seedSidePane`: discovered skills + instruction files, and
      //    the stats' context window + session start.
      const sidePane: SidePaneState = {
        ...emptySidePane,
        skillsLoaded: input.skills.map((s) => s.name),
        instructions: input.instructionFiles.map((f) => ({ path: f.path, scope: f.path })),
        stats: { ...emptyStats, startedAt: Date.now(), contextWindow: meta.contextWindow },
      }
      const store = createTuiStore({
        status: {
          modelId: meta.modelId,
          cwd: input.cwd,
          storage: storageLabel(process.env.EFFERENT_DB_URL),
          effort,
          roles: rolesChip(settings),
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

      // The navigator (agents half of the side pane) is always visible now —
      // seed it at boot so prior sessions/sub-agents show without `:tree`.
      yield* refreshNav(store, cid).pipe(Effect.catchAll(() => Effect.void))

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
        instructionFiles: input.instructionFiles,
        approvalLayer: approval.layer,
      })
      const reduce = makeEventReducer(store, {
        // Live navigator reload on sub-agent spawn/end (current session — it
        // can change via the sessions view, so resolve the id per call).
        refreshNav: () => {
          Runtime.runFork(rt)(
            refreshNav(store, store.run.getConversationId()).pipe(
              Effect.catchAll(() => Effect.void),
            ),
          )
        },
      })

      // 5. Exit signal + the context the JSX consumes.
      const exitDeferred = yield* Deferred.make<void>()
      const ctx: TuiContext = {
        store,
        run: (program) => Runtime.runPromise(rt)(program),
        submit: (text) => {
          void Runtime.runPromise(rt)(submit(text))
        },
        interrupt: () => {
          const fiber = store.run.getFiber()
          if (fiber !== undefined) Runtime.runFork(rt)(Fiber.interrupt(fiber))
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

      // 7. Drain the agent event queue into the signal store (scoped fiber).
      yield* Effect.forkScoped(runEventPump(eventQueue, reduce))

      // 7b. Spinner ticker — advances running tree-node glyphs while a turn is in
      //     flight (no signal write when idle → no idle re-renders). Scoped.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sync(() => {
            if (store.busy()) store.tickSpinner()
          }).pipe(Effect.delay("120 millis")),
        ),
      )

      // 8. Mount Solid. `createComponent` avoids JSX in this `.ts` driver.
      yield* Effect.promise(() => render(() => createComponent(App, { ctx }), renderer))

      // 9. Block until exit; scope finalizers then restore the terminal.
      yield* Deferred.await(exitDeferred)
    }),
  ).pipe(
    Effect.provide(fileLoggerLayer(logFilePath())),
  ) as Effect.Effect<void, never, AppServices>
