import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent } from "solid-js"
import { Deferred, Effect, Either, Fiber, Match, Option, Queue, Ref, Runtime, Schema, Scope } from "effect"
import { assembleContext, bundleSummary, fmtChars } from "../context/assemble.js"
import type { ContextSet, StandingSource } from "../context/context-set.entity.js"
import {
  clearPins,
  findPinIndex,
  isStandingOn,
  parsePinRef,
  renderPinRef,
  setPinOn,
  toggleStanding,
  withBudget,
  withPin,
  withoutPin,
} from "../context/context-set.entity.functions.js"
import { contextAssembledEvent, makeContextInjector, withContextBlock } from "../context/inject.js"
import { loadStandingSources } from "../context/standing.js"
import { loadContextSet, saveContextSet } from "../context/store.js"
import { contextView } from "./presentation/contextView.js"
import { FileSystem, SettingsStore } from "@xandreed/core"
import type { AuthStore, ModelCatalog, Shell } from "@xandreed/core"
import type { SpecDoc } from "@xandreed/core"
import type { SmithEvent } from "../domain/SmithEvent.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import type { ImplementorServices } from "../implementor/efferentImplementor.js"
import { loadForgeLessons, runForgeSession } from "../forge/session.js"
import { renderShipPlan, runShip } from "../forge/ship.js"
import { followUpTarget, runFollowUpTurn } from "../forge/followUp.js"
import { eventsFromRun } from "../forge/replayRun.js"
import type { ShipPlan } from "../forge/ship.js"
import { makeRefineSession } from "../refine/session.js"
import type { RefineAgent, RefineSession } from "../refine/session.js"
import {
  beginForge,
  beginRefine,
  currentSession,
  dropped,
  forgeEnded,
  forgeFiber,
  forgeStarted,
  idle,
  interruptTarget,
  isRunning,
  modeOf,
  replayed,
  runningTurn,
  shipPlan,
  shipped,
  turnEnded,
  turnStarted,
} from "./session/state.js"
import type { SessionState } from "./session/state.js"
import { makeProfileSession } from "../profile/session.js"
import { listSpecs, loadSpecDoc, lockSpecDoc, specPath } from "../spec/store.js"
import { workspaceView } from "./presentation/workspace.js"
import type { ProviderStatus, SmithProvider } from "./presentation/loginFlow.js"
import { AuthStore as AuthStoreTag, ConversationId, ConversationStore, UtilityLlm, assistantModel, assistantUsage } from "@xandreed/core"
import type { Credential } from "@xandreed/core"
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
  | ModelCatalog
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
  mode: "idle" | "profile" | "refine" | "forge",
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
      store.setViEnabled(Option.getOrElse(settings.viMode, () => false))

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
          Effect.sync(() => {
            // The tick only drives the BUSY clocks (heartbeat spinner,
            // elapsed, slow-hint) — an idle session gets ZERO periodic
            // signal writes, so nothing re-renders at rest (the palette
            // and burst check are event-driven off onContentChange).
            const phase = store.floor().phase
            if (
              store.busy() ||
              phase === "implementing" ||
              phase === "gating" ||
              phase === "boot"
            ) {
              store.tickSpinner()
            }
          }).pipe(Effect.delay("120 millis")),
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

/** Interactive quality-profile authoring over the SAME ProfileSession used
 * by headless mode: converse, inspect the dry-run panel, then :lock the
 * exact draft that was reviewed. */
export const runTuiProfile = (
  run: SmithRunConfig,
): Effect.Effect<number, never, TuiServices> =>
  withTuiChassis(run, "profile", ({ exitDeferred, publish, rt, store }) =>
    Effect.gen(function* () {
      const session = yield* makeProfileSession(run.cwd, publish, { unattended: false })

      const turn = (text: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            store.addUserLine(text)
            store.setBusy(true)
          })
          yield* session.send(text).pipe(Effect.catchAll(() => Effect.succeedNone))
          const queued = yield* Effect.sync(() => store.drainQueue())
          yield* queued.length > 0 ? turn(queued.join("\n\n")) : Effect.void
        }).pipe(Effect.ensuring(Effect.sync(() => store.setBusy(false))))

      yield* Effect.forkScoped(
        turn(
          "Analyze this workspace and propose its quality profile. Inspect its real scripts and architecture first; ask only questions that materially change the contract.",
        ),
      )

      return {
        store,
        runConfig: run,
        run: (effect) => Runtime.runPromise(rt)(effect),
        interrupt: () => store.setNotice("profile has no forge run to interrupt — :quit to leave"),
        exit: (code) => {
          Runtime.runFork(rt)(Deferred.succeed(exitDeferred, code))
        },
        sendProfile: (text) => {
          if (store.busy()) {
            store.enqueue(text)
            store.setNotice("queued — steered in at the next step")
            return
          }
          Runtime.runFork(rt)(turn(text))
        },
        lock: () => {
          Runtime.runFork(rt)(
            session.lock.pipe(
              Effect.tap(() => Effect.sync(() => store.setNotice("profile locked"))),
              Effect.catchAll((error) => Effect.sync(() => store.setNotice(error.message))),
            ),
          )
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
  /** Post-run follow-up turns (scripted in the battery). */
  readonly followUp?: typeof runFollowUpTurn
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
      const workspaceScope = yield* Effect.scope
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
      // THE session, as one value (tui/session/state.ts). Every "what is
      // running?" question is a query on it; the TUI's mode is its
      // projection; fibers register themselves as their first action.
      const stateRef = yield* Ref.make<SessionState>(idle)
      const transition = (step: (state: SessionState) => SessionState): Effect.Effect<SessionState> =>
        Ref.updateAndGet(stateRef, step).pipe(
          Effect.tap((next) => Effect.sync(() => store.setMode(modeOf(next)))),
        )
      const sessionState = Ref.get(stateRef)
      /** A fiber's first action: register as the running turn. */
      const registerTurn = Effect.withFiberRuntime<void>((fiber) =>
        transition(turnStarted(fiber)).pipe(Effect.asVoid),
      )
      /** A fiber's `ensuring`: unregister — only its own registration. */
      const unregisterTurn = Effect.withFiberRuntime<void>((fiber) =>
        transition(turnEnded(fiber)).pipe(Effect.asVoid),
      )

      /** Stop a running refine/follow-up turn (idempotent) — anything that
       *  REPLACES the story must not race a turn still writing into it. */
      const stopTurn = Effect.gen(function* () {
        const running = runningTurn(yield* sessionState)
        yield* Option.match(running, {
          onNone: () => Effect.void,
          onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
        })
      })

      // The dashboard reads: specs (undecodable ones dropped — one hand-edited
      // file can't blank the view), the forge-run history, the lessons brief.
      const SMITH_PROVIDERS: ReadonlyArray<SmithProvider> = [
        "anthropic",
        "openai",
        "google",
        "opencode",
      ]
      // The context set's panel model — re-measured after every change and
      // every workspace refresh; shell-backed pins stay DEFERRED here (a
      // refresh must never run the human's commands — a turn does).
      const refreshContext = Effect.gen(function* () {
        const set = yield* loadContextSet(run.cwd)
        const standing = yield* loadStandingSources(run.cwd, set, run.configPath)
        const bundle = yield* assembleContext(run.cwd, set, { execute: false })
        yield* Effect.sync(() => store.setContext(contextView(set, standing, bundle)))
      })
      // Follow-up turns carry the pins the way refine turns do: once, and
      // again when the human changes them (one injector per session).
      const contextInjector = yield* makeContextInjector(run.cwd, publish)

      const refreshWorkspace = Effect.gen(function* () {
        yield* refreshContext
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
          configured: Option.map(
            Option.fromNullable(
              provider === "openai"
                ? credentials.get("openai-codex") ?? credentials.get("openai")
                : credentials.get(provider),
            ),
            (c) => c.type,
          ),
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
      ): Effect.Effect<void, never, FileSystem | Shell | ConversationStore | AuthStore> =>
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
        })

      /** The turn as a registered fiber: it announces itself first and
       *  withdraws last, so the session never holds a dead handle. */
      const registered = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        registerTurn.pipe(Effect.zipRight(body), Effect.ensuring(unregisterTurn.pipe(Effect.zipRight(Effect.sync(() => store.setBusy(false))))))

      /** `:resume <id>`: rebuild the transcript through the SAME reducer the
       *  live path feeds (replay ≡ live-fold), then continue the conversation. */
      const resumeSession = (id: string): void => {
        forked(
          "resume",
          Effect.gen(function* () {
            const cid = ConversationId.make(id)
            // A turn still running would keep writing into the story we are
            // about to replace — stop it first; and the finished run's
            // follow-up target belongs to the OLD session, so the next text
            // must not land in that coder's conversation.
            yield* stopTurn
            const session = yield* makeRefineSession(run.cwd, publish, {
              unattended: false,
              resume: cid,
              pendingInput: steerFromQueue(store),
              ...(seams.refineAgent !== undefined ? { agent: seams.refineAgent } : {}),
            })
            yield* Effect.sync(() => {
              store.resetRefine()
              // The replay rebuilds the WHOLE story — it must not append to
              // whatever was on screen.
              store.resetConversation()
            })
            yield* transition(beginRefine(session))
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
      ): Effect.Effect<void, never, ConversationStore | UtilityLlm | AuthStore | FileSystem | Shell> =>
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
        yield* stopTurn
        // Re-read the workspace BEFORE the dashboard shows — switching first
        // flashed the previous dashboard (the run just finished missing from
        // its own list) for a frame or, on a slow box, several.
        yield* refreshWorkspace
        yield* Effect.sync(() => {
          store.resetRefine()
          store.resetConversation()
          // The finished run's status rows (outcome · artifact · session)
          // belong to THAT run — left standing under a fresh idea they read
          // as the next run's state (live-caught on the dashboard).
          store.resetFloor("", run.maxAttempts)
          store.setNotice("")
        })
        yield* transition(dropped)
      })

      const artifactPath = (id: string): string => join(run.cwd, ".foundry", "runs", `${id}.json`)

      /** Replay a persisted run into the floor + the story (replay ≡
       *  live-fold); optionally arm follow-up on its coder conversation and
       *  `:ship` when it was accepted — the dashboard's "report"/"follow up". */
      const replayRun = (id: string, armFollowUp: boolean) =>
        Effect.gen(function* () {
          const runs = yield* readRuns(join(run.cwd, ".foundry", "runs"))
          const found = Option.fromNullable(runs.find((r) => String(r.id) === id))
          if (Option.isNone(found)) {
            yield* Effect.sync(() => store.setNotice(`no run ${id.slice(0, 8)} on file`))
            return
          }
          const record = found.value
          if ((yield* sessionState)._tag === "Forging") {
            yield* Effect.sync(() => store.setNotice("a forge is running — wait for it, or Esc first"))
            return
          }
          yield* stopTurn
          yield* Effect.sync(() => {
            store.resetFloor(record.spec.goal, record.spec.limits.maxAttempts)
            store.resetConversation()
          })
          const target = armFollowUp
            ? followUpTarget(record.attempts.map((attempt) => attempt.implementorRef)).pipe(
                Option.flatMap((cid) => Schema.decodeUnknownOption(ConversationId)(cid)),
              )
            : Option.none<ConversationId>()
          yield* transition(
            replayed({
              followUp: target,
              ship:
                armFollowUp && record.outcome._tag === "accepted"
                  ? Option.some(renderShipPlan(run.cwd, Option.none(), record))
                  : Option.none(),
            }),
          )
          yield* Effect.forEach(eventsFromRun(record, artifactPath(id)), publish)
          yield* Effect.sync(() =>
            store.setNotice(
              !armFollowUp
                ? "run replayed — :new for the next idea"
                : Option.isSome(target)
                  ? "run replayed — follow up freely (the coder keeps its context) · :new for the next idea"
                  : "run replayed — no coder conversation on file to follow up",
            ),
          )
        })

      /** A spec on file, or a notice and None. */
      const specOnFile = (slug: string) =>
        loadSpecDoc(run.cwd, slug).pipe(
          Effect.map(Option.some),
          Effect.catchAll((error) =>
            Effect.sync(() => store.setNotice(error.message)).pipe(Effect.as(Option.none<SpecDoc>())),
          ),
        )

      const openSpec = (slug: string) =>
        Effect.gen(function* () {
          const doc = yield* specOnFile(slug)
          if (Option.isNone(doc)) return
          yield* stopTurn
          const session = yield* makeRefineSession(run.cwd, publish, {
            unattended: false,
            slug: doc.value.slug,
            pendingInput: steerFromQueue(store),
            ...(seams.refineAgent !== undefined ? { agent: seams.refineAgent } : {}),
          })
          yield* Effect.sync(() => {
            store.resetRefine()
            store.resetConversation()
          })
          yield* transition(beginRefine(session))
          const path = specPath(run.cwd, slug)
          yield* publish(
            doc.value.status === "locked"
              ? { type: "spec_locked", doc: doc.value, path }
              : { type: "spec_draft", doc: doc.value, path },
          )
          yield* Effect.sync(() =>
            store.setNotice(
              doc.value.status === "locked"
                ? `opened ${slug} (locked) — :forge to build`
                : `opened ${slug} — refine in the composer, :lock when it's right`,
            ),
          )
        })

      const lockSpec = (slug: string) =>
        Effect.gen(function* () {
          const doc = yield* specOnFile(slug)
          if (Option.isNone(doc)) return
          if (doc.value.status === "locked") {
            yield* Effect.sync(() => store.setNotice(`${slug} is already locked — :forge ${slug}`))
            return
          }
          const at = yield* Effect.sync(() => new Date().toISOString())
          const locked = yield* lockSpecDoc(run.cwd, doc.value, at).pipe(
            Effect.map(Option.some),
            Effect.catchAll((error) =>
              Effect.sync(() => store.setNotice(error.message)).pipe(Effect.as(Option.none<SpecDoc>())),
            ),
          )
          if (Option.isNone(locked)) return
          yield* refreshWorkspace
          // A refine session open on this very spec sees the lock too.
          yield* store.mode() === "refine"
            ? publish({ type: "spec_locked", doc: locked.value, path: specPath(run.cwd, slug) })
            : Effect.void
          yield* Effect.sync(() => store.setNotice(`locked ${slug} — :forge ${slug} to build`))
        })

      const deleteSpec = (slug: string) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem
          // A refine session open on this spec loses its draft — drop it first.
          const current = yield* Effect.flatMap(
            Effect.map(sessionState, currentSession),
            Option.match({
              onNone: () => Effect.succeed(Option.none<string>()),
              onSome: (session) =>
                Effect.map(session.currentDraft, Option.map((draft) => String(draft.doc.slug))),
            }),
          )
          yield* Option.exists(current, (open) => open === slug) ? dropRefine : Effect.void
          yield* fs
            .remove(specPath(run.cwd, slug))
            .pipe(Effect.catchAll((error) => Effect.sync(() => store.setNotice(error.message))))
          yield* refreshWorkspace
          yield* Effect.sync(() => store.setNotice(`deleted ${slug}`))
        })

      const sendText = (text: string): void => {
        forked(
          "send",
          Effect.gen(function* () {
            const queued = (notice: string) =>
              Effect.sync(() => {
                store.enqueue(text)
                store.setNotice(notice)
              })
            const newRefine = Effect.gen(function* () {
              const created = yield* makeRefineSession(run.cwd, publish, {
                unattended: false,
                pendingInput: steerFromQueue(store),
                ...(seams.refineAgent !== undefined ? { agent: seams.refineAgent } : {}),
              })
              yield* Effect.sync(() => {
                store.resetRefine()
                store.resetConversation()
              })
              yield* transition(beginRefine(created))
              yield* publish({ type: "refine_start", idea: Option.some(text) })
              return created
            })
            const refineTurn = (session: RefineSession, fresh: boolean) =>
              Effect.sync(() => {
                forked(
                  "turn",
                  registered(turn(session, text)).pipe(
                    // Naming is background work. Keeping it inside the turn
                    // could strand input queued after the final queue drain.
                    Effect.tap(() => fresh
                      ? autoTitle(session.conversationId, text).pipe(Effect.forkIn(workspaceScope), Effect.asVoid)
                      : Effect.void),
                  ),
                )
              })
            // A finished forge with an armed follow-up: plain text CONTINUES
            // the coder's conversation — full run context, full toolkit, no
            // spec pipeline (the human is directing; they re-:forge when the
            // next slice deserves the gates).
            const followUpTurn = (target: ConversationId) =>
              Effect.sync(() => {
                forked(
                  "follow-up",
                  registered(
                    Effect.gen(function* () {
                      yield* Effect.sync(() => {
                        store.addUserLine(text)
                        store.setBusy(true)
                      })
                      const block = yield* contextInjector.next
                      yield* (seams.followUp ?? runFollowUpTurn)(
                        run,
                        target,
                        withContextBlock(block, text),
                        publish,
                        steerFromQueue(store),
                      ).pipe(
                        Effect.catchAll((error) =>
                          publish({ type: "forge_error", message: `follow-up: ${String(error)}` }),
                        ),
                      )
                      const pending = yield* Effect.sync(() => store.drainQueue())
                      yield* pending.length > 0
                        ? Effect.sync(() => sendText(pending.join("\n\n")))
                        : Effect.void
                    }).pipe(Effect.ensuring(Effect.sync(() => store.setBusy(false)))),
                  ),
                )
              })
            // ONE decision, on the one state value — the old tree re-derived
            // "what is running" from the forge fiber, the floor's phase, the
            // busy flag, and the mode, and each pair could disagree.
            const state = yield* sessionState
            yield* Match.value(state).pipe(
              // Text typed mid-forge STEERS the coder: it lands at the next
              // loop step through the pendingInput seam.
              Match.tag("Forging", () => queued("queued — the coder reads it at its next step")),
              Match.tag("Refining", (s) =>
                Option.isSome(s.turn)
                  ? queued("queued — steered in at the next step")
                  : refineTurn(s.session, false),
              ),
              Match.tag("Forged", (s) =>
                Option.isSome(s.turn)
                  ? queued("queued — steered in at the next step")
                  : Option.match(s.followUp, {
                      onSome: followUpTurn,
                      // No follow-up target: new text starts the next idea.
                      onNone: () =>
                        dropRefine.pipe(
                          Effect.zipRight(newRefine),
                          Effect.flatMap((created) => refineTurn(created, true)),
                        ),
                    }),
              ),
              Match.tag("Idle", () => newRefine.pipe(Effect.flatMap((created) => refineTurn(created, true)))),
              Match.exhaustive,
            )
          }),
        )
      }

      const startForge = (slug: Option.Option<string>): void => {
        forked(
          "forge",
          Effect.gen(function* () {
            const state = yield* sessionState
            if (state._tag === "Forging") {
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
                Option.match(currentSession(state), {
                  onNone: () =>
                    Effect.sync(() => {
                      store.setNotice("nothing to forge — refine a spec first, or :forge <slug>")
                    }).pipe(Effect.as(Option.none<SpecDoc>())),
                  onSome: (s) =>
                    Effect.map(s.currentDraft, (draft) => Option.map(draft, (d) => d.doc)),
                }),
            })
            if (Option.isNone(doc)) return
            if (doc.value.status !== "locked") {
              yield* Effect.sync(() =>
                store.setNotice(`spec "${doc.value.slug}" is a DRAFT — :lock it first`),
              )
              return
            }
            yield* stopTurn
            yield* Effect.sync(() => {
              store.resetFloor(doc.value.goal, run.maxAttempts)
              store.resetConversation()
            })
            yield* transition(beginForge(doc.value))
            const forgeRunner = seams.forgeRunner ?? runForgeSession
            Runtime.runFork(rt)(
              // The forge fiber registers itself as its FIRST action and
              // settles the session in `ensuring` — the parent never holds
              // a handle that may already be dead (the old stale-Some race).
              Effect.withFiberRuntime<void>((fiber) =>
                transition(forgeStarted(fiber)).pipe(Effect.asVoid),
              ).pipe(
                Effect.zipRight(
                  forgeRunner({ ...run, task: doc.value.goal }, publish, doc, steerFromQueue(store)),
                ),
                // ANY finished run arms follow-up (a rejected run is the one
                // you most want to interrogate); an ACCEPTED one arms :ship.
                Effect.tap((result) =>
                  transition(
                    forgeEnded({
                      followUp: followUpTarget(
                        result.run.attempts.map((attempt) => attempt.implementorRef),
                      ).pipe(
                        // SAFE decode — a malformed ref disarms follow-up, it
                        // must never kill the finished run's fiber.
                        Option.flatMap((id) => Schema.decodeUnknownOption(ConversationId)(id)),
                      ),
                      ship:
                        result.run.outcome._tag === "accepted"
                          ? Option.some(renderShipPlan(run.cwd, doc, result.run))
                          : Option.none(),
                    }),
                  ).pipe(
                    Effect.zipRight(
                      Effect.sync(() => {
                        store.setNotice(
                          "run finished — follow up freely (the coder keeps its context) · :new for the next idea",
                        )
                      }),
                    ),
                  ),
                ),
                Effect.map((result) => (result.run.outcome._tag === "accepted" ? 0 : 1)),
                Effect.catchAll(() => Effect.succeed(2)),
                Effect.tap((code) => Effect.sync(() => store.setExitCode(code))),
                Effect.zipLeft(refreshWorkspace),
                Effect.asVoid,
                // A crashed or interrupted forge still SETTLES the session —
                // with nothing armed; a settled one is left as it is.
                Effect.ensuring(
                  transition(forgeEnded({ followUp: Option.none(), ship: Option.none() })).pipe(
                    Effect.asVoid,
                  ),
                ),
              ),
            )
          }),
        )
      }

      /** One context-set change: load → transform (or refuse with a
       *  notice) → save → re-measure the panel → say what happened. */
      const updateContext = (
        label: string,
        change: (set: ContextSet) => Either.Either<{ readonly set: ContextSet; readonly notice: string }, string>,
      ): void => {
        forked(
          label,
          Effect.gen(function* () {
            const set = yield* loadContextSet(run.cwd)
            yield* Either.match(change(set), {
              onLeft: (message) => Effect.sync(() => store.setNotice(message)),
              onRight: (next) =>
                saveContextSet(run.cwd, next.set).pipe(
                  Effect.zipRight(refreshContext),
                  Effect.zipRight(Effect.sync(() => store.setNotice(next.notice))),
                  Effect.catchAll((error) => Effect.sync(() => store.setNotice(error.message))),
                ),
            })
          }),
        )
      }

      const pinAt = (set: ContextSet, token: string) =>
        Either.fromOption(findPinIndex(set, token), () => `no such pin: ${token} (:context lists them by number)`)

      const contextActions = {
        add: (ref: string) =>
          updateContext("context add", (set) =>
            Either.map(parsePinRef(ref), (pin) => ({
              set: withPin(set, pin),
              notice: `pinned ${renderPinRef(pin)} — :context show previews what the next turn carries`,
            })),
          ),
        drop: (token: string) =>
          updateContext("context drop", (set) =>
            Either.map(pinAt(set, token), (index) => ({
              set: withoutPin(set, index),
              notice: `dropped ${renderPinRef(set.pins[index]!)}`,
            })),
          ),
        toggle: (name: StandingSource) =>
          updateContext("context toggle", (set) =>
            Either.right({
              set: toggleStanding(set, name),
              notice: `${name} ${isStandingOn(set, name) ? "off — the model stops seeing it" : "on"}`,
            }),
          ),
        set: (name: StandingSource, on: boolean) =>
          updateContext("context set", (set) =>
            isStandingOn(set, name) === on
              ? Either.left(`${name} is already ${on ? "on" : "off"}`)
              : Either.right({ set: toggleStanding(set, name), notice: `${name} ${on ? "on" : "off"}` }),
          ),
        setPin: (token: string, on: boolean) =>
          updateContext("context pin", (set) =>
            Either.map(pinAt(set, token), (index) => ({
              set: setPinOn(set, index, on),
              notice: `${renderPinRef(set.pins[index]!)} ${on ? "on" : "off"}`,
            })),
          ),
        preview: () => {
          forked(
            "context show",
            Effect.gen(function* () {
              const set = yield* loadContextSet(run.cwd)
              if (set.pins.length === 0) {
                yield* Effect.sync(() => store.setNotice("no pins — :context add <ref> pins a file, a dir/, a glob, a note, a diff, a command"))
                return
              }
              const standing = yield* loadStandingSources(run.cwd, set, run.configPath)
              const bundle = yield* assembleContext(run.cwd, set, { execute: true })
              yield* Effect.sync(() => store.setContext(contextView(set, standing, bundle)))
              yield* publish(contextAssembledEvent(bundle, false))
              yield* Effect.sync(() =>
                store.setNotice(`context preview: ${bundleSummary(bundle)} — ${fmtChars(bundle.totalChars)} chars`),
              )
            }),
          )
        },
        clear: () =>
          updateContext("context clear", (set) =>
            set.pins.length === 0
              ? Either.left("no pins to clear")
              : Either.right({ set: clearPins(set), notice: `cleared ${set.pins.length} pin(s)` }),
          ),
        budget: (chars: number) =>
          updateContext("context budget", (set) =>
            Either.right({ set: withBudget(set, chars), notice: `pins budget ${fmtChars(withBudget(set, chars).budgetChars)} chars` }),
          ),
      }

      const teardown = (): void => {
        // A live forge fiber and any OAuth loopback server must die BEFORE
        // the renderer restores, or the process outlives the terminal.
        Runtime.runFork(rt)(
          Effect.flatMap(sessionState, (state) =>
            Effect.forEach([runningTurn(state), forgeFiber(state)], (fiber) =>
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
          Runtime.runFork(rt)(
            Effect.gen(function* () {
              const target = interruptTarget(yield* sessionState)
              yield* Option.match(target, {
                onNone: () => Effect.sync(() => store.setNotice("nothing to interrupt")),
                onSome: ({ kind, fiber }) =>
                  Fiber.interrupt(fiber).pipe(
                    Effect.zipRight(
                      Effect.sync(() =>
                        store.setNotice(kind === "turn" ? "turn interrupted" : "forge interrupted"),
                      ),
                    ),
                  ),
              })
            }),
          )
        },
        isRunning: () => isRunning(Effect.runSync(Ref.get(stateRef))),
        exit: (code) => {
          teardown()
          Runtime.runFork(rt)(Deferred.succeed(exitDeferred, code))
        },
        sendText,
        lock: () => {
          Runtime.runFork(
            rt,
          )(
            Effect.flatMap(Effect.map(sessionState, currentSession), (session) =>
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
        dashboard: {
          openSpec: (slug) => {
            forked("open", openSpec(slug))
          },
          lockSpec: (slug) => {
            forked("lock", lockSpec(slug))
          },
          deleteSpec: (slug) => {
            forked("delete", deleteSpec(slug))
          },
          showRun: (id) => {
            forked("report", replayRun(id, false))
          },
          followUpRun: (id) => {
            forked("follow-up", replayRun(id, true))
          },
        },
        context: contextActions,
        resume: resumeSession,
        branch: () => {
          forked(
            "branch",
            Effect.gen(function* () {
              const session = currentSession(yield* sessionState)
              yield* Option.match(session, {
                onNone: () =>
                  Effect.sync(() =>
                    store.setNotice("nothing to branch — start or :resume a session first"),
                  ),
                onSome: (s) =>
                  Effect.gen(function* () {
                    const conv = yield* ConversationStore
                    const forkId = yield* conv.fork(s.conversationId).pipe(Effect.orDie)
                    yield* Effect.sync(() => {
                      store.setNotice("branched — this is the FORK; the original is untouched")
                      resumeSession(String(forkId))
                    })
                  }),
              })
            }),
          )
        },
        ship: () => {
          forked(
            "ship",
            Effect.gen(function* () {
              const plan = shipPlan(yield* sessionState)
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
                      Option.isSome(url) ? transition(shipped).pipe(Effect.asVoid) : Effect.void,
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
