import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent } from "solid-js"
import { Deferred, Effect, Fiber, Option, Queue, Ref, Runtime, Scope } from "effect"
import { SettingsStore } from "@xandreed/engine"
import type { AuthStore } from "@xandreed/engine"
import type { FileSystem, SpecDoc } from "@xandreed/engine"
import type { SmithEvent } from "../domain/SmithEvent.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import type { ImplementorServices } from "../implementor/efferentImplementor.js"
import { loadForgeLessons, runForgeSession } from "../forge/session.js"
import { makeRefineSession } from "../refine/session.js"
import type { RefineSession } from "../refine/session.js"
import { listSpecs, loadSpecDoc } from "../spec/store.js"
import { workspaceView } from "./presentation/workspace.js"
import { readRuns } from "@xandreed/foundry"
import { join } from "node:path"
import { runEventPump } from "./events/pump.js"
import { createSmithStore } from "./state/store.js"
import type { SmithStore, SmithTuiContext } from "./state/store.js"
import { App } from "./view/App.js"

type TuiServices = ImplementorServices | FileSystem | SettingsStore | AuthStore

/** The scoped chassis every smith TUI mode shares: queue+pump, renderer,
 *  spinner, exit Deferred. `body` wires the mode's fibers + context extras. */
const withTuiChassis = (
  run: SmithRunConfig,
  mode: "idle" | "refine" | "forge",
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

/**
 * `bare smith [--cwd]` on a TTY: the PERSISTENT workspace session — the
 * Claude-Code shape. Opens on the workspace dashboard (specs · forge runs ·
 * lessons); composer text starts a refine; `:lock`/`:forge` run the forge in
 * the SAME session with the floor live; completion refreshes the dashboard
 * and the next idea starts over. Exit only via :quit / Ctrl-C.
 */
export const runTuiWorkspace = (
  run: SmithRunConfig,
): Effect.Effect<number, never, TuiServices> =>
  withTuiChassis(run, "idle", ({ exitDeferred, publish, rt, store }) =>
    Effect.gen(function* () {
      const refineRef = yield* Ref.make(Option.none<RefineSession>())
      const forgeFiberRef = yield* Ref.make(Option.none<Fiber.RuntimeFiber<void>>())

      // The dashboard reads: specs (undecodable ones dropped — one hand-edited
      // file can't blank the view), the forge-run history, the lessons brief.
      const refreshWorkspace = Effect.gen(function* () {
        const slugs = yield* listSpecs(run.cwd)
        const docs = yield* Effect.forEach(slugs, (slug) =>
          loadSpecDoc(run.cwd, slug).pipe(
            Effect.map(Option.some),
            Effect.catchAll(() => Effect.succeedNone),
          ),
        )
        const runs = yield* readRuns(join(run.cwd, ".foundry", "runs"))
        const lessons = yield* loadForgeLessons(run.cwd)
        store.setWorkspace(
          workspaceView(docs.flatMap(Option.toArray), runs, lessons),
        )
      })
      yield* refreshWorkspace

      const turn = (
        session: RefineSession,
        text: string,
      ): Effect.Effect<void, never, FileSystem> =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            store.addUserLine(text)
            store.setBusy(true)
          })
          yield* session.send(text).pipe(Effect.catchAll(() => Effect.succeedNone))
          yield* Effect.sync(() => store.setBusy(false))
          yield* refreshWorkspace
        })

      const dropRefine = Effect.gen(function* () {
        yield* Ref.set(refineRef, Option.none())
        yield* Effect.sync(() => {
          store.resetRefine()
          store.setMode("idle")
        })
        yield* refreshWorkspace
      })

      const sendText = (text: string): void => {
        Runtime.runFork(
          rt,
        )(
          Effect.gen(function* () {
            const running = yield* Ref.get(forgeFiberRef)
            if (Option.isSome(running)) {
              yield* Effect.sync(() =>
                store.setNotice("a forge is running — Esc interrupts it first"),
              )
              return
            }
            if (store.busy()) {
              yield* Effect.sync(() =>
                store.setNotice("the refiner is thinking — one turn at a time"),
              )
              return
            }
            // A finished forge floor: new text implicitly starts the next idea.
            if (store.mode() === "forge") {
              yield* dropRefine
            }
            const existing = yield* Ref.get(refineRef)
            const session = yield* Option.match(existing, {
              onSome: (s) => Effect.succeed(s),
              onNone: () =>
                Effect.gen(function* () {
                  const created = yield* makeRefineSession(run.cwd, publish, {
                    unattended: false,
                  })
                  yield* Ref.set(refineRef, Option.some(created))
                  yield* Effect.sync(() => {
                    store.resetRefine()
                    store.setMode("refine")
                  })
                  yield* publish({ type: "refine_start", idea: Option.some(text) })
                  return created
                }),
            })
            yield* turn(session, text)
          }),
        )
      }

      const startForge = (slug: Option.Option<string>): void => {
        Runtime.runFork(
          rt,
        )(
          Effect.gen(function* () {
            const running = yield* Ref.get(forgeFiberRef)
            if (Option.isSome(running)) {
              yield* Effect.sync(() => store.setNotice("a forge is already running"))
              return
            }
            const doc = yield* Option.match(slug, {
              onSome: (s) =>
                loadSpecDoc(run.cwd, s).pipe(
                  Effect.map(Option.some),
                  Effect.catchAll((error) =>
                    Effect.sync(() => {
                      store.setNotice(error.message)
                    }).pipe(Effect.as(Option.none<SpecDoc>())),
                  ),
                ),
              onNone: () =>
                Effect.flatMap(Ref.get(refineRef), (session) =>
                  Option.match(session, {
                    onNone: () =>
                      Effect.sync(() => {
                        store.setNotice("nothing to forge — refine a spec first, or :forge <slug>")
                      }).pipe(Effect.as(Option.none<SpecDoc>())),
                    onSome: (s) =>
                      Effect.map(s.currentDraft, (draft) => Option.map(draft, (d) => d.doc)),
                  }),
                ),
            })
            if (Option.isNone(doc)) return
            if (doc.value.status !== "locked") {
              yield* Effect.sync(() =>
                store.setNotice(`spec "${doc.value.slug}" is a DRAFT — :lock it first`),
              )
              return
            }
            yield* Effect.sync(() => {
              store.resetFloor(doc.value.goal, run.maxAttempts)
              store.setMode("forge")
            })
            const fiber = Runtime.runFork(rt)(
              runForgeSession({ ...run, task: doc.value.goal }, publish, doc).pipe(
                Effect.map((result) => (result.run.outcome._tag === "accepted" ? 0 : 1)),
                Effect.catchAll(() => Effect.succeed(2)),
                Effect.tap((code) => Effect.sync(() => store.setExitCode(code))),
                Effect.zipLeft(refreshWorkspace),
                Effect.asVoid,
                Effect.ensuring(Ref.set(forgeFiberRef, Option.none())),
              ),
            )
            yield* Ref.set(forgeFiberRef, Option.some(fiber))
          }),
        )
      }

      const teardown = (): void => {
        // A live forge fiber and any OAuth loopback server must die BEFORE
        // the renderer restores, or the process outlives the terminal.
        Runtime.runFork(rt)(
          Effect.flatMap(Ref.get(forgeFiberRef), (fiber) =>
            Option.match(fiber, {
              onNone: () => Effect.void,
              onSome: (f) => Fiber.interrupt(f).pipe(Effect.asVoid),
            }),
          ),
        )
        Option.match(store.oauth(), {
          onNone: () => undefined,
          onSome: (session) => {
            session.stop()
            return undefined
          },
        })
      }

      return {
        store,
        runConfig: run,
        run: (effect) => Runtime.runPromise(rt)(effect),
        interrupt: () => {
          Runtime.runFork(
            rt,
          )(
            Effect.flatMap(Ref.get(forgeFiberRef), (fiber) =>
              Option.match(fiber, {
                onNone: () =>
                  Effect.sync(() => store.setNotice("nothing to interrupt")),
                onSome: (f) => Fiber.interrupt(f).pipe(Effect.asVoid),
              }),
            ),
          )
        },
        exit: (code) => {
          teardown()
          Runtime.runFork(rt)(Deferred.succeed(exitDeferred, code))
        },
        sendText,
        lock: () => {
          Runtime.runFork(
            rt,
          )(
            Effect.flatMap(Ref.get(refineRef), (session) =>
              Option.match(session, {
                onNone: () =>
                  Effect.sync(() => store.setNotice("no draft to lock — describe an idea first")),
                onSome: (s) =>
                  s.lock.pipe(
                    Effect.tap(() =>
                      Effect.sync(() => store.setNotice("locked — :forge to build")),
                    ),
                    Effect.zipLeft(refreshWorkspace),
                    Effect.catchAll((error) =>
                      Effect.sync(() => store.setNotice(error.message)),
                    ),
                    Effect.asVoid,
                  ),
              }),
            ),
          )
        },
        forge: (slug?: string) => startForge(Option.fromNullable(slug)),
        newSpec: () => {
          Runtime.runFork(rt)(dropRefine)
        },
      }
    }),
  )

