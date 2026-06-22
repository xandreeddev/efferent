import { homedir } from "node:os"
import { join } from "node:path"
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent } from "solid-js"
import { batch } from "solid-js"
import { Deferred, Effect, Runtime, Schema, Stream } from "effect"
import { FetchHttpClient } from "@effect/platform"
import {
  ConversationId,
  LlmInfo,
  ModelRegistry,
  SettingsStore,
  StoreSwitch,
  connLabel,
  sessionConversationId,
  SessionId,
  type Directive,
  type SessionSummary,
  type WorkspaceSnapshot,
} from "@xandreed/sdk-core"
import type { TuiModeInput } from "../modes/tui.js"
import { fileLoggerLayer } from "./presentation/logger.js"
import { rolesChip } from "./presentation/statusBar.js"
import { emptySidePane, emptyStats, type SidePaneState } from "./presentation/sidePane.js"
import { App } from "./view/App.js"
import { treeSitterClient } from "./view/syntax.js"
import { stopOAuthSession } from "./actions/login.js"
import { applyContext } from "./actions/session.js"
import { refreshNav } from "./actions/contextTree.js"
import { makeEventReducer } from "./events/eventPump.js"
import { createTuiStore, type AppServices, type TuiContext } from "./state/store.js"
import { setTheme } from "./state/theme.js"
import { makeRemoteWorkspace } from "../workspace/remote.js"
import { attachOrSpawn } from "../server/attach.js"

const logFilePath = (): string =>
  join(process.env.EFFERENT_HOME ?? join(homedir(), ".efferent"), "efferent.log")

const decodeConversationId = Schema.decodeUnknown(ConversationId)

/**
 * The **remote TUI driver** — a thin client that attaches to the per-workspace
 * daemon over HTTP/SSE instead of running the agent in-process. Opt-in behind
 * `EFFERENT_REMOTE`; the default `runtime.ts` (in-process) is untouched.
 *
 * It reuses the entire view + store + event reducer + presentation: the only
 * differences are the Workspace source (a `remote` adapter pointed at the
 * daemon) and the event source (the SSE `subscribe` stream instead of a local
 * queue). `ctx.run` still runs LOCAL concerns (`:login`/`:model`/`:theme` —
 * auth.json + the model registry are the client's machine); agent runs go to
 * the daemon. Detaching (exit) leaves the daemon and its fleet alive.
 */
export const runTuiModeRemote = (
  input: TuiModeInput,
): Effect.Effect<void, never, AppServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      // Local status (model/effort/storage) — same as the in-process driver.
      const info = yield* LlmInfo
      const meta = yield* info.metadata
      const registry = yield* ModelRegistry
      const sel = yield* registry.current
      const settings = yield* (yield* SettingsStore).get()
      if (settings.theme !== undefined) setTheme(settings.theme)
      const effort =
        sel.provider === "anthropic"
          ? settings.anthropicThinkingEffort
          : sel.provider === "openai"
            ? settings.openAiReasoningEffort
            : sel.provider === "google"
              ? settings.geminiThinkingLevel
              : undefined
      const activeDb = yield* (yield* StoreSwitch).current

      const rt = yield* Effect.runtime<AppServices>()

      // Attach to (or spawn) the workspace daemon, then build a remote Workspace.
      const { baseUrl } = yield* attachOrSpawn(input.cwd).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => {
            process.stderr.write(`efferent: could not reach the daemon — ${e.message}\n`)
            process.exit(1)
          }).pipe(Effect.zipRight(Effect.never)),
        ),
      )
      const ws = yield* makeRemoteWorkspace(baseUrl).pipe(Effect.provide(FetchHttpClient.layer))

      // The daemon's active session is our root.
      const snap0: WorkspaceSnapshot = yield* ws.snapshot().pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => {
            process.stderr.write(`efferent: daemon snapshot failed — ${e.message}\n`)
            process.exit(1)
          }).pipe(Effect.zipRight(Effect.never)),
        ),
      )
      // --fleet <id> pins which coordinator we attach to (the dashboard's
      // "attach" action copies exactly this); else the daemon's active/first root.
      const requestedFleet =
        input.fleetId !== undefined
          ? snap0.sessions.find((s) => s.kind === "root" && (s.id as string) === input.fleetId)?.id
          : undefined
      if (input.fleetId !== undefined && requestedFleet === undefined) {
        yield* Effect.sync(() =>
          process.stderr.write(
            `efferent: no fleet ${input.fleetId} on this daemon — attaching to the active one\n`,
          ),
        )
      }
      const rootSessionId =
        requestedFleet ??
        snap0.activeSessionId ??
        snap0.sessions.find((s) => s.kind === "root")?.id
      if (rootSessionId === undefined) {
        yield* Effect.sync(() => {
          process.stderr.write("efferent: the daemon has no root session\n")
          process.exit(1)
        })
        return
      }
      const rootCid = sessionConversationId(rootSessionId)

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
          storage: connLabel(activeDb.name, activeDb.kind),
          effort,
          roles: rolesChip(settings),
        },
        conversationId: rootCid,
        footer: `daemon ${baseUrl} · logs: tail -f ${logFilePath()}`,
        sidePane,
      })

      // Mutable client caches refreshed from the daemon snapshot.
      let snapshotCache: WorkspaceSnapshot = snap0
      let directiveCache: Directive | undefined = snap0.directive ?? undefined
      const runningAgents = (): ReadonlyArray<SessionSummary> =>
        snapshotCache.sessions.filter((s) => s.kind === "agent" && s.status === "running")
      const refreshSnapshot = (): void => {
        void Runtime.runPromise(rt)(
          ws.snapshot().pipe(
            Effect.tap((s) =>
              Effect.sync(() => {
                snapshotCache = s
                directiveCache = s.directive ?? undefined
              }),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        )
      }

      // Seed the rail from the daemon's persisted log (DB rebuild on attach).
      const state0 = yield* ws.getState(rootSessionId).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      let cursor = state0?.cursor ?? 0
      if (state0 !== undefined) {
        yield* Effect.sync(() => applyContext(store, rootCid, state0.log, [], { collapseContext: false }))
      }
      store.pushBlock({
        kind: "info",
        text: "attached to daemon · type to chat (↵ sends) · : for commands · ? for keys",
      })

      // Seed the always-visible fleet tree from the SHARED store (the client
      // process has `ContextTreeStore`/`ConversationStore` in `AppServices` and
      // already reads them for `openNodePreview`). The daemon stamps every
      // spawn's node with `rootConversationId === rootCid`, so `listTree(rootCid)`
      // returns the daemon's fleet — current-session-only, always expanded.
      yield* refreshNav(store, rootCid, { activeOnly: true }).pipe(
        Effect.catchAll(() => Effect.void),
      )
      const refreshFleet = (): void => {
        void Runtime.runPromise(rt)(
          refreshNav(store, rootCid, { activeOnly: true }).pipe(Effect.catchAll(() => Effect.void)),
        )
      }

      // Each sub-agent start/end (and turn end) refreshes BOTH the snapshot
      // cache (the `:fleet`/`liveAgents` views) and the fleet tree (the right
      // pane) — so a running fleet appears and flips status live on the daemon
      // path exactly as it does in-process.
      const reduce = makeEventReducer(store, {
        refreshNav: () => {
          refreshSnapshot()
          refreshFleet()
        },
      })

      const exitDeferred = yield* Deferred.make<void>()
      const ctx: TuiContext = {
        store,
        // The remote driver backs the `efferent` master assistant — always the
        // full-chrome "master" variant (`code` runs the in-process driver).
        variant: input.variant ?? "master",
        run: (program) => Runtime.runPromise(rt)(program),
        submit: (text) => {
          // Jumped into an agent? Route the message to THAT node's session — the
          // daemon delivers to a running node's mailbox or resumes a finished one
          // (Workspace.send handles both). The composer is paired with the agent,
          // so the optimistic line goes into ITS log (AgentPane shows nodeLog),
          // not the root rail — and its reply streams back tagged with the node id.
          const preview = store.nodePreview()
          if (preview !== undefined) {
            const sid = Schema.decodeUnknownOption(SessionId)(preview.nodeId)
            if (sid._tag === "Some") {
              store.appendNodeLog(preview.nodeId, { kind: "user", text })
              store.setInput("")
              store.convScroller.current?.scrollToBottom()
              void Runtime.runPromise(rt)(
                ws.send(sid.value, text).pipe(
                  Effect.tap(() => Effect.sync(refreshFleet)),
                  // Fleet plumbing — a delivery hiccup is a transient toast (the
                  // daemon already logged it to efferent.log), not a chat block.
                  Effect.catchAll((e) => Effect.sync(() => store.toast(`agent: ${e.message}`))),
                ),
              )
              return
            }
          }
          // Optimistic user line (the daemon persists it but emits no user event).
          store.pushBlock({ kind: "user", text })
          store.setInput("")
          store.convScroller.current?.scrollToBottom()
          void Runtime.runPromise(rt)(
            ws.send(rootSessionId, text).pipe(
              Effect.catchAll((e) =>
                Effect.sync(() => store.pushBlock({ kind: "error", text: e.message })),
              ),
            ),
          )
        },
        interrupt: () => {
          void Runtime.runPromise(rt)(ws.interrupt(rootSessionId).pipe(Effect.ignore))
        },
        roles: input.agents,
        tools: input.tools,
        spawnAgent: (agent, folder, task) => {
          void Runtime.runPromise(rt)(
            ws.spawn({ agent, folder, task }).pipe(
              Effect.tap(() => Effect.sync(refreshSnapshot)),
              Effect.catchAll((e) =>
                Effect.sync(() => store.pushBlock({ kind: "error", text: e.message })),
              ),
            ),
          )
        },
        stopAgent: (id) => {
          const target = runningAgents()[id - 1] ?? runningAgents()[id]
          if (target !== undefined) {
            void Runtime.runPromise(rt)(ws.stop(target.id).pipe(Effect.ignore))
          }
        },
        listFleet: () =>
          runningAgents().map((s, i) => ({
            id: i + 1,
            title: s.title ?? s.folder,
            folder: s.folder,
          })),
        liveAgents: () =>
          runningAgents().map((s) => ({ nodeId: s.id as string, label: s.title ?? s.folder })),
        importAgents: (spec) => {
          void Runtime.runPromise(rt)(
            ws.importAgents(spec).pipe(
              Effect.tap((res) =>
                Effect.sync(() =>
                  store.pushBlock({
                    kind: "info",
                    text: `imported ${res.written.join(", ") || "nothing"} (applies on next launch)`,
                  }),
                ),
              ),
              Effect.catchAll((e) =>
                Effect.sync(() => store.pushBlock({ kind: "error", text: `import failed: ${e.message}` })),
              ),
            ),
          )
        },
        importTools: (spec) => {
          void Runtime.runPromise(rt)(
            ws.importTools(spec).pipe(
              Effect.tap((res) =>
                Effect.sync(() =>
                  store.pushBlock({
                    kind: "info",
                    text: `imported ${res.written.join(", ") || "nothing"} (applies on next launch)`,
                  }),
                ),
              ),
              Effect.catchAll((e) =>
                Effect.sync(() => store.pushBlock({ kind: "error", text: `import failed: ${e.message}` })),
              ),
            ),
          )
        },
        getDirective: () => directiveCache,
        setDirective: (d) => {
          directiveCache = d
          void Runtime.runPromise(rt)(ws.setDirective(d).pipe(Effect.ignore))
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
        resolveApproval: (decision) => {
          void Runtime.runPromise(rt)(ws.approve(rootSessionId, decision).pipe(Effect.ignore))
        },
      }

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => process.stderr.write("efferent: detaching from daemon…\n")),
      )

      const renderer = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true, targetFps: 30 }),
        ),
        (r) => Effect.sync(() => r.destroy()),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => treeSitterClient()?.destroy() ?? Promise.resolve()).pipe(Effect.ignore),
      )
      yield* Effect.addFinalizer(() => stopOAuthSession(store).pipe(Effect.ignore))

      // Spinner ticker — advances while a turn or fleet is live (busy is derived
      // from agentState here, fed by the SSE stream).
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sync(() => {
            if (store.busy() || store.agentState().fleet.length > 0) store.tickSpinner()
          }).pipe(Effect.delay("120 millis")),
        ),
      )

      // The event pump: drain the daemon's SSE stream into the store, reusing
      // makeEventReducer verbatim. Reconnect on stream end/error — re-fetch the
      // state (DB rebuild) and resume from its cursor (the resync path).
      const pump = Effect.gen(function* () {
        while (true) {
          yield* ws
            .subscribe(rootSessionId, cursor)
            .pipe(
              Stream.runForEach((se) =>
                Effect.sync(() => {
                  cursor = se.seq
                  batch(() => reduce(se.event))
                }),
              ),
              Effect.catchAll(() => Effect.void),
            )
          // Stream ended/errored → reconnect after re-syncing from the DB.
          yield* Effect.sleep("1 second")
          const st = yield* ws.getState(rootSessionId).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
          if (st !== undefined) {
            cursor = st.cursor
            yield* Effect.sync(() =>
              applyContext(store, rootCid, st.log, [], { collapseContext: false }),
            )
          }
        }
      })
      yield* Effect.forkScoped(pump)

      yield* Effect.promise(() => render(() => createComponent(App, { ctx }), renderer))
      yield* Deferred.await(exitDeferred)
    }),
  ).pipe(Effect.provide(fileLoggerLayer(logFilePath()))) as Effect.Effect<void, never, AppServices>
