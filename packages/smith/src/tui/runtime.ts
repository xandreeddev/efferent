import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent } from "solid-js"
import { Deferred, Effect, Fiber, Option, Queue, Runtime, Scope } from "effect"
import { SettingsStore } from "@xandreed/engine"
import type { AuthStore } from "@xandreed/engine"
import type { FileSystem, SpecDoc } from "@xandreed/engine"
import type { SmithEvent } from "../domain/SmithEvent.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import type { ImplementorServices } from "../implementor/efferentImplementor.js"
import { runForgeSession } from "../forge/session.js"
import { makeRefineSession } from "../refine/session.js"
import { runEventPump } from "./events/pump.js"
import { createSmithStore } from "./state/store.js"
import type { SmithStore, SmithTuiContext } from "./state/store.js"
import { App } from "./view/App.js"

type TuiServices = ImplementorServices | FileSystem | SettingsStore | AuthStore

/** The scoped chassis every smith TUI mode shares: queue+pump, renderer,
 *  spinner, exit Deferred. `body` wires the mode's fibers + context extras. */
const withTuiChassis = (
  run: SmithRunConfig,
  mode: "refine" | "forge",
  body: (chassis: {
    readonly store: SmithStore
    readonly publish: (event: SmithEvent) => Effect.Effect<void>
    readonly rt: Runtime.Runtime<TuiServices>
    readonly exitDeferred: Deferred.Deferred<number>
  }) => Effect.Effect<SmithTuiContext, never, TuiServices | Scope.Scope>,
): Effect.Effect<number, never, TuiServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<SmithEvent>()
      const publish = (event: SmithEvent) =>
        Queue.offer(queue, event).pipe(Effect.asVoid)
      const rt = yield* Effect.runtime<TuiServices>()

      const settings = yield* Effect.flatMap(SettingsStore, (store) => store.load).pipe(
        Effect.orDie,
      )
      const general = Option.getOrElse(settings.model, () => "(unset)")
      const store = createSmithStore(
        run,
        {
          general,
          code: Option.getOrElse(settings.codeModel, () => general),
          fast: Option.getOrElse(settings.fastModel, () => general),
        },
        mode,
      )

      const exitDeferred = yield* Deferred.make<number>()
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

      yield* Effect.forkScoped(runEventPump(queue, store.reduce))
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sync(() => store.tickSpinner()).pipe(Effect.delay("120 millis")),
        ),
      )

      const ctx = yield* body({ store, publish, rt, exitDeferred })

      yield* Effect.promise(() =>
        render(() => createComponent(App, { ctx }), renderer),
      )
      return yield* Deferred.await(exitDeferred)
    }),
  )

/**
 * The factory-floor TUI: the cli's three-runtime bridge (Effect owns the forge
 * session fiber, Solid owns the view state, OpenTUI owns the terminal),
 * borrowed at its minimum. The renderer is a scoped resource, the pump and
 * session are scope-bound fibers, and exit rides one Deferred — so the
 * terminal restores on success, failure, AND interruption.
 */
export const runTui = (
  run: SmithRunConfig,
  doc: Option.Option<SpecDoc> = Option.none(),
): Effect.Effect<number, never, TuiServices> =>
  withTuiChassis(run, "forge", ({ exitDeferred, publish, rt, store }) =>
    Effect.gen(function* () {
      const session = yield* Effect.forkScoped(
        runForgeSession(run, publish, doc).pipe(
          Effect.map((result) => (result.run.outcome._tag === "accepted" ? 0 : 1)),
          Effect.catchAll(() => Effect.succeed(2)),
          Effect.tap((code) => Effect.sync(() => store.setExitCode(code))),
        ),
      )
      return {
        store,
        runConfig: run,
        run: (effect) => Runtime.runPromise(rt)(effect),
        interrupt: () => {
          Runtime.runFork(rt)(Fiber.interrupt(session))
        },
        exit: (code) => {
          Runtime.runFork(rt)(Deferred.succeed(exitDeferred, code))
        },
      }
    }),
  )

/**
 * `smith spec "<idea>"` on a TTY: refine mode. The composer drives refiner
 * turns; `:lock` approves the draft; `:forge` transitions THIS TUI into the
 * factory floor over the locked spec. `--yes` auto-locks after the first
 * draft (unattended refiner, review stays in the panel).
 */
export const runTuiRefine = (
  run: SmithRunConfig,
  idea: string,
  autoLock: boolean,
): Effect.Effect<number, never, TuiServices> =>
  withTuiChassis(run, "refine", ({ exitDeferred, publish, rt, store }) =>
    Effect.gen(function* () {
      const session = yield* makeRefineSession(run.cwd, publish, {
        unattended: autoLock,
      })
      yield* publish({ type: "refine_start", idea: Option.some(idea) })

      const turn = (text: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            store.addUserLine(text)
            store.setBusy(true)
          })
          const draft = yield* session.send(text).pipe(Effect.catchAll(() => Effect.succeedNone))
          yield* Effect.sync(() => {
            store.setBusy(false)
            if (autoLock && Option.isSome(draft) && !store.refine().locked) {
              store.setNotice("draft ready — auto-locking (--yes)")
            }
          })
          if (autoLock && Option.isSome(draft) && !store.refine().locked) {
            yield* session.lock.pipe(Effect.catchAll(() => Effect.void))
          }
        })

      // The opening turn: the idea itself.
      yield* Effect.forkScoped(turn(idea))

      const startForge = (): void => {
        Runtime.runFork(
          rt,
        )(
          Effect.gen(function* () {
            const draft = yield* session.currentDraft
            if (Option.isNone(draft) || !store.refine().locked) {
              yield* Effect.sync(() =>
                store.setNotice(
                  store.refine().locked ? "no draft to forge" : "lock the spec first (:lock)",
                ),
              )
              return
            }
            yield* Effect.sync(() => store.setMode("forge"))
            const doc = draft.value.doc
            const code = yield* runForgeSession(
              { ...run, task: doc.goal },
              publish,
              Option.some(doc),
            ).pipe(
              Effect.map((result) => (result.run.outcome._tag === "accepted" ? 0 : 1)),
              Effect.catchAll(() => Effect.succeed(2)),
            )
            yield* Effect.sync(() => store.setExitCode(code))
          }),
        )
      }

      return {
        store,
        runConfig: run,
        run: (effect) => Runtime.runPromise(rt)(effect),
        interrupt: () => {
          store.setNotice("refine has no run to interrupt — :quit to leave")
        },
        exit: (code) => {
          Runtime.runFork(rt)(Deferred.succeed(exitDeferred, code))
        },
        sendRefine: (text) => {
          if (store.busy()) {
            store.setNotice("the refiner is thinking — one turn at a time")
            return
          }
          Runtime.runFork(rt)(turn(text))
        },
        lock: () => {
          Runtime.runFork(
            rt,
          )(
            session.lock.pipe(
              Effect.tap(() => Effect.sync(() => store.setNotice("locked — :forge to build"))),
              Effect.catchAll((error) =>
                Effect.sync(() => store.setNotice(error.message)),
              ),
            ),
          )
        },
        forge: startForge,
      }
    }),
  )
