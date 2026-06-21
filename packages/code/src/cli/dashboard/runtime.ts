import { homedir } from "node:os"
import { join } from "node:path"
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent } from "solid-js"
import { Deferred, Effect, Runtime, Stream } from "effect"
import { FetchHttpClient } from "@effect/platform"
import { AuthStore, SettingsStore, type SessionId } from "@xandreed/sdk-core"
import { fileLoggerLayer } from "../presentation/logger.js"
import { treeSitterClient } from "../view/syntax.js"
import { setTheme } from "../state/theme.js"
import type { AppServices } from "../state/store.js"
import { makeRemoteWorkspace } from "../../workspace/remote.js"
import { makeHttpTransport } from "../../transport/http/client.js"
import { attachOrSpawn } from "../../server/attach.js"
import { createDashboardStore } from "./state/dashboardStore.js"
import { messageLine } from "./presentation/dashboardView.js"
import { Dashboard } from "./view/Dashboard.js"

const logFilePath = (): string =>
  join(process.env.EFFERENT_HOME ?? join(homedir(), ".efferent"), "efferent.log")

/**
 * The **control dashboard** driver — a k9s-style operator console that attaches
 * to (or spawns) the workspace daemon and shows fleets → agents, live metrics,
 * and the "messages flying" stream, with operator actions. A thin remote client
 * like `remoteRuntime.ts` (which it mirrors), but read-mostly + control rather
 * than a conversation. Launched by `efferent daemon`.
 */
export const runDashboard = (
  input: { readonly cwd: string },
): Effect.Effect<void, never, AppServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* (yield* SettingsStore).get()
      if (settings.theme !== undefined) setTheme(settings.theme)

      const rt = yield* Effect.runtime<AppServices>()
      const { baseUrl } = yield* attachOrSpawn(input.cwd).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => {
            process.stderr.write(`efferent: could not reach the daemon — ${e.message}\n`)
            process.exit(1)
          }).pipe(Effect.zipRight(Effect.never)),
        ),
      )
      const ws = yield* makeRemoteWorkspace(baseUrl).pipe(Effect.provide(FetchHttpClient.layer))
      const transport = makeHttpTransport(baseUrl)
      const store = createDashboardStore()

      // No-credential banner — the daemon is headless; onboard via the coder.
      const auth = yield* (yield* AuthStore).all
      store.setNeedsLogin(Object.keys(auth).length === 0)

      const exitDeferred = yield* Deferred.make<void>()
      const exit = () => Runtime.runFork(rt)(Deferred.succeed(exitDeferred, undefined))

      const actions = {
        attach: (s: { id: SessionId }) => {
          const cmd = `efferent --fleet ${s.id}`
          renderer.copyToClipboardOSC52(cmd)
          store.setNote(`copied: ${cmd} — run it in another terminal to pair with this fleet`)
        },
        spawnFleet: () => {
          void Runtime.runPromise(rt)(
            ws.createFleet({ folder: input.cwd }).pipe(
              Effect.tap(() => Effect.sync(() => store.setNote("spawned a new fleet"))),
              Effect.catchAll((e) => Effect.sync(() => store.setNote(`spawn failed: ${e.message}`))),
            ),
          )
        },
        stop: (s: { id: SessionId }) => {
          void Runtime.runPromise(rt)(ws.stop(s.id).pipe(Effect.ignore))
          store.setNote("stopped agent")
        },
        interrupt: (s: { id: SessionId }) => {
          void Runtime.runPromise(rt)(ws.interrupt(s.id).pipe(Effect.ignore))
          store.setNote("interrupted fleet")
        },
        shutdown: () => {
          void Runtime.runPromise(rt)(
            transport.shutdown().pipe(Effect.provide(FetchHttpClient.layer), Effect.ignore),
          ).then(exit)
        },
        quit: exit,
      }

      const renderer = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true, targetFps: 30 }),
        ),
        (r) => Effect.sync(() => r.destroy()),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => treeSitterClient()?.destroy() ?? Promise.resolve()).pipe(Effect.ignore),
      )

      // Pollers: refresh metrics + the fleet/agent list every ~1.5s.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const m = yield* ws.metrics().pipe(Effect.catchAll(() => Effect.succeed(undefined)))
            if (m !== undefined) store.setMetrics(m)
            const s = yield* ws.listSessions().pipe(Effect.catchAll(() => Effect.succeed(undefined)))
            if (s !== undefined) store.setSessions(s)
          }).pipe(Effect.delay("1500 millis")),
        ),
      )

      // Firehose: seed the message tail, then stream board_note events live.
      const snap = yield* ws.snapshot().pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      const streamId =
        snap?.activeSessionId ?? ("00000000-0000-0000-0000-000000000000" as SessionId)
      const seeded = yield* ws.messages(100).pipe(Effect.catchAll(() => Effect.succeed([])))
      store.pushMessages(seeded.map(messageLine))
      yield* Effect.forkScoped(
        Effect.forever(
          ws
            .subscribe(streamId, undefined)
            .pipe(
              Stream.runForEach((se) => {
                const e = se.event
                if (e.type !== "board_note") return Effect.void
                return Effect.sync(() =>
                  store.pushMessages([{ from: e.from, content: e.note, at: e.at }]),
                )
              }),
              Effect.catchAll(() => Effect.void),
              Effect.zipRight(Effect.sleep("1 second")),
            ),
        ),
      )

      const width = process.stdout.columns ?? 100
      yield* Effect.promise(() =>
        render(() => createComponent(Dashboard, { ctx: { store, width, actions } }), renderer),
      )
      yield* Deferred.await(exitDeferred)
    }),
  ).pipe(Effect.provide(fileLoggerLayer(logFilePath()))) as Effect.Effect<void, never, AppServices>
