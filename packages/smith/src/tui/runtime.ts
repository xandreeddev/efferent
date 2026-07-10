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
import { renderShipPlan, runShip } from "../forge/ship.js"
import type { ShipPlan } from "../forge/ship.js"
import { makeRefineSession } from "../refine/session.js"
import type { RefineAgent, RefineSession } from "../refine/session.js"
import { listSpecs, loadSpecDoc } from "../spec/store.js"
import { workspaceView } from "./presentation/workspace.js"
import type { ProviderStatus, SmithProvider } from "./presentation/loginFlow.js"
import { AuthStore as AuthStoreTag, ConversationId, ConversationStore, UtilityLlm, assistantModel, assistantUsage } from "@xandreed/engine"
import type { Credential } from "@xandreed/engine"
import { readRuns } from "@xandreed/foundry"
import { join } from "node:path"
import { runEventPump } from "./events/pump.js"
import { createSmithStore } from "./state/store.js"
import type { SmithStore, SmithTuiContext } from "./state/store.js"
import { App } from "./view/App.js"

export type TuiServices =
  | ImplementorServices
  | FileSystem
  | SettingsStore
  | AuthStore
  | UtilityLlm

/** The persisted content-part vocabulary `:resume` replays (see the engine's
 *  `responseToAgentMessages` for the writing side). */
interface ReplayPart {
  readonly type?: string
  readonly text?: string
  readonly toolCallId?: string
  readonly toolName?: string
  readonly input?: unknown
  readonly output?: unknown
  readonly isError?: boolean
}

const joinReplayText = (parts: ReadonlyArray<ReplayPart>, type: "text" | "reasoning"): string =>
  parts
    .filter((p) => p.type === type)
    .map((p) => p.text ?? "")
    .join("")
    .trim()

/** The MID-TURN steering thunk (the engine's `pendingInput` seam): drain the
 *  queue at a step boundary, land the text as a user block, and say so —
 *  queued messages stop waiting for the whole run to finish. */
const steerFromQueue = (store: SmithStore) => (): Effect.Effect<Option.Option<string>> =>
  Effect.sync(() => {
    const queued = store.drainQueue()
    if (queued.length === 0) return Option.none<string>()
    const text = queued.join("\n\n")
    store.addUserLine(text)
    store.setNotice("steered — your message reached the running turn")
    return Option.some(text)
  })

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
): Effect.Effect<number, never, TuiServices> => {
  const bootedAt = Date.now()
  return Effect.scoped(
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

      yield* Effect.forkScoped(runEventPump(queue, store.reduceBatch))
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
  ).pipe(
    // After the scope closed (terminal restored): one self-describing line —
    // "mystery exits" become a code + an uptime instead of a guessing game.
    Effect.tap((code) =>
      Effect.sync(() => {
        const seconds = ((Date.now() - bootedAt) / 1000).toFixed(1)
        console.error(`smith: session ended (code ${code} after ${seconds}s)`)
      }),
    ),
  )
}

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
        pendingInput: steerFromQueue(store),
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
            if (autoLock && Option.isSome(draft) && !store.refine().locked) {
              store.setNotice("draft ready — auto-locking (--yes)")
            }
          })
          if (autoLock && Option.isSome(draft) && !store.refine().locked) {
            yield* session.lock.pipe(Effect.catchAll(() => Effect.void))
          }
          // Anything typed WHILE this turn ran is drained into the next one,
          // all at once — never dropped, never held until the session ends.
          const queued = yield* Effect.sync(() => store.drainQueue())
          yield* queued.length > 0 ? turn(queued.join("\n\n")) : Effect.void
        }).pipe(Effect.ensuring(Effect.sync(() => store.setBusy(false))))

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
              steerFromQueue(store),
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
            store.enqueue(text)
            store.setNotice("queued — steered in at the next step")
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
/** The chassis surface a workspace body builds its context over — exported
 *  so the TUI test harness can mount the SAME wiring over a test renderer. */
export interface WorkspaceChassis {
  readonly store: SmithStore
  readonly publish: (event: SmithEvent) => Effect.Effect<void>
  readonly rt: Runtime.Runtime<TuiServices>
  readonly exitDeferred: Deferred.Deferred<number>
}

/** Test seams: production uses the real refiner agent + runForgeSession;
 *  the TUI battery injects the scripted twins (the SAME seams the scenario
 *  packs drive). */
export interface WorkspaceSeams {
  readonly refineAgent?: RefineAgent
  readonly forgeRunner?: typeof runForgeSession
}

export const makeWorkspaceBody = (
  run: SmithRunConfig,
  seams: WorkspaceSeams = {},
) =>
  ({ exitDeferred, publish, rt, store }: WorkspaceChassis): Effect.Effect<
    SmithTuiContext,
    never,
    TuiServices | Scope.Scope
  > =>
    Effect.gen(function* () {
      // NOTHING forked may die silently — a crashed driver action surfaces
      // on the notice line (live-caught: a swallowed defect looked like
      // "nothing happens" to the user).
      const forked = <A, E>(label: string, effect: Effect.Effect<A, E, TuiServices>) =>
        Runtime.runFork(rt)(
          effect.pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                store.setNotice(`${label} crashed: ${String(cause).slice(0, 140)}`)
              }),
            ),
          ),
        )
      const refineRef = yield* Ref.make(Option.none<RefineSession>())
      const forgeFiberRef = yield* Ref.make(Option.none<Fiber.RuntimeFiber<void>>())
      const turnFiberRef = yield* Ref.make(Option.none<Fiber.RuntimeFiber<void>>())
      // The last ACCEPTED run's ship plan — `:ship` consumes it (once).
      const shipPlanRef = yield* Ref.make(Option.none<ShipPlan>())

      // The dashboard reads: specs (undecodable ones dropped — one hand-edited
      // file can't blank the view), the forge-run history, the lessons brief.
      const SMITH_PROVIDERS: ReadonlyArray<SmithProvider> = [
        "anthropic",
        "openai",
        "google",
        "opencode",
      ]
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
        const auth = yield* AuthStoreTag
        const credentials = yield* auth.all.pipe(
          Effect.orElseSucceed(() => new Map<string, Credential>()),
        )
        const statuses: ReadonlyArray<ProviderStatus> = SMITH_PROVIDERS.map((provider) => ({
          provider,
          configured: Option.map(Option.fromNullable(credentials.get(provider)), (c) => c.type),
        }))
        const conv = yield* ConversationStore
        const sessions = yield* conv
          .listByWorkspace(run.cwd)
          .pipe(Effect.orElseSucceed(() => []))
        store.setWorkspace(
          workspaceView(
            docs.flatMap(Option.toArray),
            runs,
            lessons,
            statuses,
            sessions,
            Date.now(),
          ),
        )
      })
      yield* refreshWorkspace

      // busy resets via `ensuring` — a failed OR INTERRUPTED turn must never
      // leave the session locked (live-caught: a stalled model call froze the
      // whole TUI with no way out).
      const turn = (
        session: RefineSession,
        text: string,
      ): Effect.Effect<void, never, FileSystem | ConversationStore | AuthStore> =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            store.addUserLine(text)
            store.setBusy(true)
          })
          yield* session.send(text).pipe(Effect.catchAll(() => Effect.succeedNone))
          yield* refreshWorkspace
          // Drain anything typed during this turn into the next one, batched —
          // the queue is read on the NEXT iteration, not held to session end.
          const queued = yield* Effect.sync(() => store.drainQueue())
          yield* queued.length > 0 ? turn(session, queued.join("\n\n")) : Effect.void
        }).pipe(Effect.ensuring(Effect.sync(() => store.setBusy(false))))

      /** `:resume <id>`: rebuild the transcript through the SAME reducer the
       *  live path feeds (replay ≡ live-fold), then continue the conversation. */
      const resumeSession = (id: string): void => {
        forked(
          "resume",
          Effect.gen(function* () {
            const cid = ConversationId.make(id)
            const session = yield* makeRefineSession(run.cwd, publish, {
              unattended: false,
              resume: cid,
              pendingInput: steerFromQueue(store),
              ...(seams.refineAgent !== undefined ? { agent: seams.refineAgent } : {}),
            })
            yield* Ref.set(refineRef, Option.some(session))
            yield* Effect.sync(() => {
              store.resetRefine()
              store.setMode("refine")
            })
            const conv = yield* ConversationStore
            const messages = yield* conv.list(cid).pipe(Effect.orElseSucceed(() => []))
            yield* Effect.forEach(messages, (message) => {
              if (message.role === "user" && typeof message.content === "string") {
                return message.content.startsWith("[")
                  ? Effect.void
                  : Effect.sync(() => store.addUserLine(message.content as string))
              }
              // Assistant turn: rebuild the FULL story — reasoning stays
              // reasoning (never fused into the reply), tool calls become
              // pane blocks, and the persisted usage stamp restores the
              // model + spend tag (replay ≡ live-fold).
              if (message.role === "assistant" && Array.isArray(message.content)) {
                const parts = message.content as ReadonlyArray<ReplayPart>
                const text = joinReplayText(parts, "text")
                const reasoning = joinReplayText(parts, "reasoning")
                const toolCalls = parts.flatMap((p) =>
                  p.type === "tool-call"
                    ? [
                        {
                          id: String(p.toolCallId ?? ""),
                          toolName: String(p.toolName ?? ""),
                          args: p.input ?? {},
                        },
                      ]
                    : [],
                )
                if (text.trim().length === 0 && reasoning.length === 0 && toolCalls.length === 0) {
                  return Effect.void
                }
                const usage = Option.getOrElse(assistantUsage(message), () => ({
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                  cacheReadTokens: 0,
                }))
                return Effect.zipRight(
                  publish({
                    type: "agent",
                    event: {
                      type: "assistant_message",
                      turnIndex: 0,
                      text,
                      reasoning,
                      toolCalls,
                      usage,
                      ...Option.match(assistantModel(message), {
                        onNone: () => ({}),
                        onSome: (model) => ({ model }),
                      }),
                    },
                  }),
                  Effect.forEach(toolCalls, (call) =>
                    publish({
                      type: "agent",
                      event: {
                        type: "tool_start",
                        turnIndex: 0,
                        toolCallId: call.id,
                        toolName: call.toolName,
                        args: call.args,
                      },
                    }),
                  ),
                )
              }
              // Tool results flip the replayed tool blocks to their outcome.
              if (message.role === "tool" && Array.isArray(message.content)) {
                const parts = message.content as ReadonlyArray<ReplayPart>
                return Effect.forEach(
                  parts.flatMap((p) => (p.type === "tool-result" ? [p] : [])),
                  (p) =>
                    publish({
                      type: "agent",
                      event: {
                        type: "tool_end",
                        turnIndex: 0,
                        toolCallId: String(p.toolCallId ?? ""),
                        toolName: String(p.toolName ?? ""),
                        args: {},
                        ok: p.isError !== true,
                        result: p.output ?? {},
                      },
                    }),
                )
              }
              return Effect.void
            })
            // The RECOVERED draft announces itself AFTER the replay (the
            // reset above would wipe an earlier event): the SpecPanel, the
            // flow stepper, and :lock are live the moment you resume — a
            // resumed session with a spec on disk was a DEADLOCK before
            // ("nothing to lock", and the model refused to re-propose).
            const draft = yield* session.currentDraft
            yield* Option.match(draft, {
              onNone: () => Effect.void,
              onSome: (ref) =>
                publish({ type: "spec_draft", doc: ref.doc, path: ref.path }),
            })
            yield* Effect.sync(() =>
              store.setNotice("session resumed — continue refining, or :new to leave it"),
            )
          }),
        )
      }

      const autoTitle = (
        cid: ConversationId,
        firstText: string,
      ): Effect.Effect<void, never, ConversationStore | UtilityLlm | AuthStore | FileSystem> =>
        Effect.gen(function* () {
          const conv = yield* ConversationStore
          const utility = yield* UtilityLlm
          const completion = yield* utility
            .complete(
              `Name this coding session in 3 to 6 plain words — no quotes, no punctuation, just the words:\n\n${firstText.slice(0, 400)}`,
            )
            .pipe(Effect.orDie)
          const title = completion.text.trim().split("\n")[0]?.slice(0, 60) ?? ""
          if (title.length === 0) return
          yield* conv.setTitle(cid, title).pipe(Effect.orDie)
          yield* refreshWorkspace
        }).pipe(Effect.catchAllDefect(() => Effect.void))

      const dropRefine = Effect.gen(function* () {
        yield* Ref.set(refineRef, Option.none())
        yield* Effect.sync(() => {
          store.resetRefine()
          store.resetConversation()
          store.setMode("idle")
        })
        yield* refreshWorkspace
      })

      const sendText = (text: string): void => {
        forked(
          "send",
          Effect.gen(function* () {
            const running = yield* Ref.get(forgeFiberRef)
            if (Option.isSome(running)) {
              // Text typed mid-forge STEERS the coder: it lands at the next
              // loop step through the pendingInput seam (was a refusal).
              yield* Effect.sync(() => {
                store.enqueue(text)
                store.setNotice("queued — the coder reads it at its next step")
              })
              return
            }
            if (store.busy()) {
              yield* Effect.sync(() => {
                store.enqueue(text)
                store.setNotice("queued — steered in at the next step")
              })
              return
            }
            // A finished forge floor: new text implicitly starts the next idea.
            if (store.mode() === "forge") {
              yield* dropRefine
            }
            const existing = yield* Ref.get(refineRef)
            const fresh = Option.isNone(existing)
            const session = yield* Option.match(existing, {
              onSome: (s) => Effect.succeed(s),
              onNone: () =>
                Effect.gen(function* () {
                  const created = yield* makeRefineSession(run.cwd, publish, {
                    unattended: false,
                    pendingInput: steerFromQueue(store),
                    ...(seams.refineAgent !== undefined ? { agent: seams.refineAgent } : {}),
                  })
                  yield* Ref.set(refineRef, Option.some(created))
                  yield* Effect.sync(() => {
                    store.resetRefine()
                    store.resetConversation()
                    store.setMode("refine")
                  })
                  yield* publish({ type: "refine_start", idea: Option.some(text) })
                  return created
                }),
            })
            const fiber = forked(
              "turn",
              turn(session, text).pipe(
                // The FAST model names a new session after its first turn —
                // the dashboard's sessions list shows titles, not truncated
                // prompts. Failures are silent; the title is a nicety.
                Effect.zipLeft(
                  fresh
                    ? autoTitle(session.conversationId, text).pipe(
                        Effect.catchAll(() => Effect.void),
                      )
                    : Effect.void,
                ),
                Effect.ensuring(Ref.set(turnFiberRef, Option.none())),
              ),
            )
            yield* Ref.set(turnFiberRef, Option.some(fiber))
          }),
        )
      }

      const startForge = (slug: Option.Option<string>): void => {
        forked(
          "forge",
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
              store.resetConversation()
              store.setMode("forge")
            })
            const forgeRunner = seams.forgeRunner ?? runForgeSession
            const fiber = Runtime.runFork(rt)(
              forgeRunner({ ...run, task: doc.value.goal }, publish, doc, steerFromQueue(store)).pipe(
                // An ACCEPTED run arms `:ship`; anything else disarms it.
                Effect.tap((result) =>
                  Ref.set(
                    shipPlanRef,
                    result.run.outcome._tag === "accepted"
                      ? Option.some(renderShipPlan(run.cwd, doc, result.run))
                      : Option.none(),
                  ),
                ),
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
          Effect.forEach([forgeFiberRef, turnFiberRef], (ref) =>
            Effect.flatMap(Ref.get(ref), (fiber) =>
              Option.match(fiber, {
                onNone: () => Effect.void,
                onSome: (f) => Fiber.interrupt(f).pipe(Effect.asVoid),
              }),
            ),
          ).pipe(Effect.asVoid),
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
            Effect.gen(function* () {
              const turnFiber = yield* Ref.get(turnFiberRef)
              if (Option.isSome(turnFiber)) {
                yield* Fiber.interrupt(turnFiber.value)
                yield* Effect.sync(() => store.setNotice("turn interrupted"))
                return
              }
              const forgeFiber = yield* Ref.get(forgeFiberRef)
              yield* Option.match(forgeFiber, {
                onNone: () =>
                  Effect.sync(() => store.setNotice("nothing to interrupt")),
                onSome: (f) => Fiber.interrupt(f).pipe(Effect.asVoid),
              })
            }),
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
        resume: resumeSession,
        ship: () => {
          forked(
            "ship",
            Effect.gen(function* () {
              const plan = yield* Ref.get(shipPlanRef)
              yield* Option.match(plan, {
                onNone: () =>
                  Effect.sync(() =>
                    store.setNotice("nothing to ship — :ship follows an ACCEPTED forge run"),
                  ),
                onSome: (p) =>
                  runShip(p, publish).pipe(
                    Effect.tap((url) =>
                      Effect.sync(() =>
                        store.setNotice(
                          Option.match(url, {
                            onNone: () => "ship stopped — see the pane for the failed step",
                            onSome: (u) => `shipped: ${u}`,
                          }),
                        ),
                      ),
                    ),
                    // A successful ship disarms the plan; a failed one stays
                    // armed so a fixed environment can retry with :ship.
                    Effect.tap((url) =>
                      Option.isSome(url) ? Ref.set(shipPlanRef, Option.none()) : Effect.void,
                    ),
                    Effect.asVoid,
                  ),
              })
            }),
          )
        },
      }
    })

export const runTuiWorkspace = (
  run: SmithRunConfig,
): Effect.Effect<number, never, TuiServices> =>
  withTuiChassis(run, "idle", makeWorkspaceBody(run))

