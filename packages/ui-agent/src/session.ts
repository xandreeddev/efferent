import { LanguageModel, Toolkit } from "@effect/ai"
import { Duration, Effect, Fiber, Option, Ref, Schedule } from "effect"
import { ConversationStore, makeSession, runAgent, toAgentFailure, toolResultFailure } from "@xandreed/engine"
import type { ConversationId, LoopEvent, Session } from "@xandreed/engine"
import { foldPageEvents } from "./domain/ui-page.entity.functions.js"
import type { UiBlock, UiPage } from "./domain/ui-page.entity.js"
import { UiAgentExecutionProfile, UiAgentModels } from "./ports/ui-agent-runtime.port.js"
import { UiHost } from "./ports/ui-host.port.js"
import { UiPageStore } from "./ports/ui-page-store.port.js"
import { UiComponentCatalog } from "./ports/ui-component-catalog.port.js"
import { UiThemeStore } from "./ports/ui-theme-store.port.js"
import type { UiComponentCatalogService } from "./ports/ui-component-catalog.port.js"
import type { UiThemeStoreService } from "./ports/ui-theme-store.port.js"
import { makeUiAgentHandlers, uiAgentToolkit } from "./toolkit.js"
import { uiComposerPrompt, uiPlannerPrompt, uiRepairPrompt } from "./prompts.js"
import { admitComponent, retrieveComponents, componentPromptLine } from "./domain/ui-component.entity.functions.js"
import { validatePageCompleteness } from "./domain/ui-quality.functions.js"
import { CORE_UI_COMPONENTS } from "./domain/core-components.functions.js"
import { decodeUiProtocolChunk, emptyUiProtocolDecoderState } from "./domain/ui-generation-protocol.entity.functions.js"
import type { UiProtocolRecord } from "./domain/ui-generation-protocol.entity.js"
import { extractEarlyPatch, extractEarlyStart } from "./domain/ui-early-admission.functions.js"
import type { EarlyStart } from "./domain/ui-early-admission.functions.js"

/**
 * Stage-boundary telemetry: wall-clock stamps for the turn's server receive
 * and each model stage's start/settle. Ledgered like every non-delta event,
 * so evidence readers (the matrix, scenario packs) can attribute the paint
 * budget per stage — without them the composer/repair interval is opaque.
 * `settled` always fires, timeout and failure paths included.
 */
export interface UiStageEvent {
  readonly type: "ui_stage"
  readonly stage: "turn" | "planner" | "composer" | "repair"
  readonly phase: "started" | "settled"
  readonly at: number
}

export type UiAgentEvent = LoopEvent | import("./domain/ui-page.entity.js").UiPageEvent | UiStageEvent
export type UiAgentSession = Session<UiAgentEvent>
export type UiAgentRunServices = ConversationStore | UiPageStore | UiHost | UiAgentModels | UiAgentExecutionProfile

const defaultCatalog: UiComponentCatalogService = {
  list: Effect.succeed(CORE_UI_COMPONENTS),
  admit: (definition) => Effect.succeed(admitComponent(definition, CORE_UI_COMPONENTS)),
  recordUsage: () => Effect.void,
  usages: () => Effect.succeed([]),
}

const defaultThemes: UiThemeStoreService = { list: Effect.succeed([]), put: () => Effect.void }

/** FNV-1a over the shared prompt contract: one server-side prefill-cache
 * lane per host contract, shared by every stage, conversation, and worker
 * (probe-verified safe under concurrency on the codex route). */
const contractCacheKey = (contract: string): string =>
  `ui-contract-${[...contract].reduce((hash, ch) => Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261 >>> 0).toString(16)}`

export const makeUiAgentSession = (args: { readonly conversationId: ConversationId }): Effect.Effect<UiAgentSession, never, UiAgentRunServices> =>
  Effect.gen(function* () {
    const conversationStore = yield* ConversationStore
    const pageStore = yield* UiPageStore
    const host = yield* UiHost
    const catalogOption = yield* Effect.serviceOption(UiComponentCatalog)
    const themeOption = yield* Effect.serviceOption(UiThemeStore)
    const catalog: UiComponentCatalogService = Option.getOrElse(catalogOption, () => defaultCatalog)
    const themes: UiThemeStoreService = Option.getOrElse(themeOption, () => defaultThemes)
    const models = yield* UiAgentModels
    const profile = yield* UiAgentExecutionProfile
    const activeAttempt = yield* Ref.make(Option.none<Fiber.RuntimeFiber<void>>())
    const interruptAttempt = Ref.get(activeAttempt).pipe(
      Effect.flatMap(Option.match({
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
      })),
      Effect.zipRight(Ref.set(activeAttempt, Option.none())),
    )

    const session = yield* makeSession<UiAgentEvent, ConversationStore>({
      conversationId: args.conversationId,
      onError: (message) => ({ type: "error", message }),
      isTransient: (event) => event.type === "assistant_delta",
      runTurn: (text, publish) => Effect.gen(function* () {
        // Suspended so `at` is stamped when the effect RUNS (a settled stamp
        // built eagerly would carry the stage's start time).
        const stamp = (stage: UiStageEvent["stage"], phase: UiStageEvent["phase"]) =>
          Effect.suspend(() => publish({ type: "ui_stage", stage, phase, at: Date.now() }))
        yield* stamp("turn", "started")
        yield* interruptAttempt
        yield* publish({ type: "turn_start", turnIndex: 0 })
        const definitions = yield* catalog.list.pipe(Effect.catchAll((message) => Effect.logWarning(`component catalog unavailable: ${message}`).pipe(Effect.as([]))))
        const relevantComponents = retrieveComponents(definitions, text, 18)
        const promptContract = {
          designSystem: { id: host.tokens.id, version: host.tokens.version },
          recipes: [...host.recipes],
          assets: [...host.assets.keys()],
          capabilities: [...host.actions.keys(), ...host.queries.keys()],
          components: relevantComponents.map(componentPromptLine),
        }
        const protocol = profile.protocol ?? "native-tools"
        const decoder = yield* Ref.make(emptyUiProtocolDecoderState())
        // Streaming admission (native-tools): per tool-call argument buffers.
        // start_ui opens the page from its argument prefix AT MOST once
        // (`started`); patch_ui upserts each block the moment its own JSON
        // completes (`admittedBlocks` counts how many already painted). The
        // settled call remains the authority: its re-open MERGES via the
        // page fold, its full patch is an idempotent upsert, and ONLY it may
        // declare complete.
        const toolParams = yield* Ref.make<ReadonlyMap<string, { readonly toolName: string; readonly buffer: string; readonly started: boolean; readonly admittedBlocks: number }>>(new Map())
        const rejectedRecords = yield* Ref.make<ReadonlyArray<{ readonly record: UiProtocolRecord; readonly finding: string }>>([])
        const handlers = makeUiAgentHandlers(args.conversationId, pageStore, host, publish, catalog, themes)
        const applyRecord = (record: UiProtocolRecord): Effect.Effect<void> => Effect.gen(function* () {
          const toolkit = yield* uiAgentToolkit
          const named = record.op === "start"
            ? { name: "start_ui" as const, outcome: yield* toolkit.handle("start_ui", record.input) }
            : record.op === "patch"
              ? { name: "patch_ui" as const, outcome: yield* toolkit.handle("patch_ui", record.input) }
              : record.op === "prop"
                ? { name: "patch_ui_prop" as const, outcome: yield* toolkit.handle("patch_ui_prop", record.input) }
                : record.op === "component"
                  ? { name: "propose_component" as const, outcome: yield* toolkit.handle("propose_component", record.input) }
                  : { name: "patch_theme" as const, outcome: yield* toolkit.handle("patch_theme", record.input) }
          if (!named.outcome.isFailure) return
          const failure = toolResultFailure(named.outcome.result, named.name)
          yield* Ref.update(rejectedRecords, (current) => [...current, { record, finding: `[${failure.code}] ${failure.message}` }])
          yield* publish({ type: "error", message: `${named.name} record rejected: ${failure.message}`, failure })
        }).pipe(
          Effect.provide(handlers),
          Effect.catchAll((error) => {
            const failure = toAgentFailure(error, `ui-protocol:${record.op}`)
            return publish({ type: "error", message: `${record.op} record failed: ${failure.message}`, failure })
          }),
        )
        const ingestProtocol = (chunk: string, isDelta: boolean): Effect.Effect<void> => Ref.modify(decoder, (state) => {
          const decoded = decodeUiProtocolChunk(protocol, state, chunk, isDelta)
          return [decoded, decoded.state] as const
        }).pipe(
          Effect.flatMap((decoded) => Effect.forEach(decoded.findings, (finding) => Effect.logWarning(`UI ${protocol} record rejected: ${finding}`), { discard: true }).pipe(Effect.as(decoded.records))),
          Effect.flatMap((records) => Effect.forEach(records, applyRecord, { concurrency: 1, discard: true })),
        )
        // Early admissions are failure-SILENT: the settled call owns
        // rejections (recording an early rejection would hand repair
        // duplicate findings).
        const earlyOpen = (early: EarlyStart): Effect.Effect<void> => Effect.gen(function* () {
          const toolkit = yield* uiAgentToolkit
          yield* toolkit.handle("start_ui", { page: early.page, criticalBlocks: [early.firstBlock] })
        }).pipe(
          Effect.provide(handlers),
          Effect.asVoid,
          Effect.catchAll(() => Effect.void),
        )
        const earlyUpsert = (pageId: string, blocks: ReadonlyArray<UiBlock>): Effect.Effect<void> => Effect.gen(function* () {
          const toolkit = yield* uiAgentToolkit
          yield* toolkit.handle("patch_ui", { pageId, blocks })
        }).pipe(
          Effect.provide(handlers),
          Effect.asVoid,
          Effect.catchAll(() => Effect.void),
        )
        const trackToolParams = (event: { readonly id: string; readonly delta: string; readonly toolName?: string }): Effect.Effect<void> =>
          protocol !== "native-tools" ? Effect.void : Ref.modify(toolParams, (map) => {
            const existing = map.get(event.id) ?? { toolName: event.toolName ?? "", buffer: "", started: false, admittedBlocks: 0 }
            const entry = {
              toolName: existing.toolName === "" ? event.toolName ?? "" : existing.toolName,
              buffer: existing.buffer + event.delta,
              started: existing.started,
              admittedBlocks: existing.admittedBlocks,
            }
            return [entry, new Map(map).set(event.id, entry)] as const
          }).pipe(
            Effect.flatMap((entry) => {
              if (entry.toolName === "start_ui" && !entry.started && entry.buffer.includes('"criticalBlocks"')) {
                return Option.match(extractEarlyStart(entry.buffer), {
                  onNone: () => Effect.void,
                  onSome: (early) => Ref.update(toolParams, (map) => new Map(map).set(event.id, { ...entry, started: true })).pipe(
                    Effect.zipRight(earlyOpen(early)),
                  ),
                })
              }
              if (entry.toolName === "patch_ui" && entry.buffer.includes('"blocks"')) {
                return Option.match(extractEarlyPatch(entry.buffer), {
                  onNone: () => Effect.void,
                  onSome: (patch) => patch.blocks.length <= entry.admittedBlocks
                    ? Effect.void
                    : Ref.update(toolParams, (map) => new Map(map).set(event.id, { ...entry, admittedBlocks: patch.blocks.length })).pipe(
                      Effect.zipRight(earlyUpsert(patch.pageId, patch.blocks.slice(entry.admittedBlocks))),
                    ),
                })
              }
              return Effect.void
            }),
          )
        const stagePublish = (event: LoopEvent): Effect.Effect<void> => {
          if (event.type === "turn_start" || event.type === "agent_end") return Effect.void
          if (event.type === "assistant_delta" && event.channel === "tool-params") return trackToolParams(event).pipe(Effect.zipRight(publish(event)))
          if (event.type === "assistant_delta" && event.channel === "text") return ingestProtocol(event.delta, true).pipe(Effect.zipRight(publish(event)))
          if (event.type === "assistant_message" && protocol !== "native-tools") return Ref.get(decoder).pipe(
            Effect.flatMap((state) => ingestProtocol(state.sawDelta ? "\n" : `${event.text}\n`, false)),
            Effect.zipRight(publish(event)),
          )
          return publish(event)
        }
        // The profile timeout is a SOFT budget (pacing target); the hard
        // deadline is 3x it, capped at 55s — late content beats a flat
        // failure, and accepted patches stay rendered either way.
        const stageDeadline = (stage: "planner" | "composer" | "repair"): Duration.Duration =>
          Duration.millis(Math.min(profile[stage].timeoutMs * 3, 55_000))
        /** Worst honest attempt: planner + composer + both repair windows. */
        const stageDeadlineTotalMs =
          Duration.toMillis(stageDeadline("planner")) +
          Duration.toMillis(stageDeadline("composer")) +
          2 * Duration.toMillis(stageDeadline("repair"))
        const publishFailure = (stage: "planner" | "composer" | "repair", error: unknown) => {
          const failure = toAgentFailure(error, stage)
          return Effect.logWarning(`UI ${stage} gave up after ${Duration.toMillis(stageDeadline(stage))}ms (3x the ${profile[stage].timeoutMs}ms budget): [${failure.code}] ${failure.message}`).pipe(
            Effect.zipRight(publish({ type: "error", message: `UI ${stage} failed after an extended wait: ${failure.message} — any blocks already accepted remain on the page`, failure })),
          )
        }
        const attemptConversationId = yield* conversationStore.create(`ui-attempt:${args.conversationId}`).pipe(Effect.orDie)

        // THE STAGE GOAL declares victory deterministically: a stage settles
        // the moment its observable outcome exists in the page store, instead
        // of waiting for the model to say "done" — the post-goal continuation
        // turn otherwise parks on provider empties until the stage deadline
        // (measured 40-50s per stage in the 2026-07-16 campaign). The grace
        // lets the in-flight turn settle and persist before the interrupt.
        const goalReached = (reached: () => Effect.Effect<boolean>): Effect.Effect<void> =>
          Effect.suspend(reached).pipe(
            Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("250 millis") }),
            Effect.zipRight(Effect.sleep("2 seconds")),
            Effect.asVoid,
          )

        // One shared prefill-cache lane for every stage and worker of this
        // host contract (the role sentence sits at the END of each prompt,
        // so the contract is a byte-identical prefix across all of them).
        const promptCacheKey = contractCacheKey(uiPlannerPrompt(promptContract, protocol))
        // One bounded model call, stamp-free — the building block for the
        // stamped single-stage wrapper AND the composer fleet. Disconnect
        // UNDER the deadline: `Effect.timeout` declares victory by
        // interrupting the model call, and a provider continuation that
        // hangs with zero events resists interruption — a plain timeout
        // then waits on the wedge instead of ending the stage (the
        // cappedTrial physics, one level down). The abandoned call leaks in
        // the background; every stage boundary stays punctual.
        const stageCall = (stage: "planner" | "composer" | "repair", system: string, userPrompt: string, conversation: ConversationId) => {
          const stageProfile = profile[stage]
          const configured = protocol === "native-tools"
            ? runAgent(
              { system, toolkit: uiAgentToolkit, maxSteps: stageProfile.maxSteps, toolConcurrency: 1, streaming: true, modelPolicy: { effort: stageProfile.effort, maxOutputTokens: stageProfile.maxOutputTokens }, promptCacheKey },
              conversation,
              userPrompt,
              { onEvent: stagePublish },
            )
            : runAgent(
              { system, toolkit: Toolkit.empty, maxSteps: stageProfile.maxSteps, toolConcurrency: 1, streaming: true, modelPolicy: { effort: stageProfile.effort, maxOutputTokens: stageProfile.maxOutputTokens }, promptCacheKey },
              conversation,
              userPrompt,
              { onEvent: stagePublish },
            )
          return configured.pipe(
            Effect.provideService(LanguageModel.LanguageModel, models[stage]),
            Effect.provide(handlers),
            Effect.disconnect,
            Effect.timeout(stageDeadline(stage)),
            Effect.catchAll((error) => publishFailure(stage, error)),
          )
        }
        // The loser is DISCONNECTED: a goal victory must never wait on the
        // model call's interruption — a hung provider continuation resists
        // it (the 2026-07-16 campaigns: pages COMPLETED, then the turn
        // wedged to the trial cap). The abandoned call self-terminates on
        // its own deadline in the background; late events it publishes
        // after the goal are inert.
        const runStage = (stage: "planner" | "composer" | "repair", system: string, userPrompt: string, goal?: Effect.Effect<void>) => {
          const bounded = stageCall(stage, system, userPrompt, attemptConversationId)
          return stamp(stage, "started").pipe(
            Effect.zipRight(goal === undefined ? bounded : Effect.race(Effect.disconnect(bounded), goal)),
            Effect.ensuring(stamp(stage, "settled")),
          )
        }

        const repair = (stage: "planner" | "composer", request: string, acceptedPage: unknown, goal: Effect.Effect<void>) => Effect.gen(function* () {
          if (profile.repair.maxAttempts < 1) return
          const rejected = yield* Ref.get(rejectedRecords)
          yield* Ref.set(rejectedRecords, [])
          const findings = rejected.length === 0
            ? [stage === "planner" ? "start did not produce an accepted page" : "the accepted page is not complete"]
            : rejected.map((entry) => entry.finding)
          yield* runStage(
            "repair",
            uiRepairPrompt(promptContract, protocol, stage === "planner"),
            `[repair-stage]\n${stage}\n\n[request]\n${request}\n\n[accepted-page]\n${acceptedPage === undefined ? "none" : JSON.stringify(acceptedPage)}\n\n[rejected-records]\n${JSON.stringify(rejected.map((entry) => entry.record))}\n\n[semantic-findings]\n${findings.join("\n")}`,
            goal,
          )
        })

        // The barrier gate: fleet workers never declare complete — once every
        // required slot has content, the HARNESS declares it, and the handler
        // still validates completeness for real. Failure-silent: an
        // incomplete page falls through to the normal repair path.
        const declareComplete = (pageId: string): Effect.Effect<void> => Effect.gen(function* () {
          const toolkit = yield* uiAgentToolkit
          yield* toolkit.handle("patch_ui", { pageId, blocks: [], complete: true })
        }).pipe(Effect.provide(handlers), Effect.asVoid, Effect.catchAll(() => Effect.void))

        /** Phase 3: the composer fans out over DISJOINT slot ranges, one
         * child conversation per worker (interleaved appends on a shared
         * conversation would corrupt alternation). Block upsert-by-id is
         * idempotent and the ranges are disjoint, so worker writes compose;
         * ONE composer stage interval brackets the whole fleet. */
        const runComposerFleet = (page: UiPage, workers: number, remaining: ReadonlyArray<string>, goal: Effect.Effect<void>) => Effect.gen(function* () {
          const ranges = remaining.reduce<ReadonlyArray<ReadonlyArray<string>>>(
            (acc, id, index) => acc.map((range, worker) => worker === index % workers ? [...range, id] : range),
            Array.from({ length: workers }, () => []),
          )
          // Each worker's OWN victory condition: all of its assigned slots
          // have accepted blocks. Without it a finished worker's
          // continuation turn parks to the stage deadline (the page-complete
          // goal can never fire for a worker — workers never complete).
          const workerGoal = (ids: ReadonlyArray<string>) => goalReached(() =>
            pageStore.list(args.conversationId).pipe(
              Effect.orDie,
              Effect.map((events) => {
                const folded = foldPageEvents(events).find((candidate) => candidate.manifest.id === page.manifest.id)
                return folded !== undefined && ids.every((id) => folded.blocks.some((block) => block.id === id))
              }),
            ))
          const workerCall = (ids: ReadonlyArray<string>, index: number) => Effect.gen(function* () {
            const conversation = yield* conversationStore.create(`ui-composer-worker-${index}:${args.conversationId}`).pipe(Effect.orDie)
            yield* Effect.race(
              Effect.disconnect(stageCall(
                "composer",
                uiComposerPrompt(promptContract, protocol),
                `[request]\n${text}\n\n[accepted-page]\n${JSON.stringify(page)}\n\nFill ONLY these slots with specific, useful content: ${ids.join(", ")}. Another worker owns every other slot — do not touch them and do NOT set complete.`,
                conversation,
              )),
              workerGoal(ids),
            )
          })
          const fleet = Effect.all(ranges.filter((range) => range.length > 0).map((ids, index) => workerCall(ids, index)), { concurrency: workers }).pipe(Effect.asVoid)
          yield* stamp("composer", "started").pipe(
            Effect.zipRight(Effect.race(Effect.disconnect(fleet), goal)),
            Effect.ensuring(stamp("composer", "settled")),
          )
          const events = yield* pageStore.list(args.conversationId).pipe(Effect.orDie)
          const folded = foldPageEvents(events).find((candidate) => candidate.manifest.id === page.manifest.id)
          yield* folded !== undefined && !folded.complete && validatePageCompleteness(folded).length === 0
            ? declareComplete(page.manifest.id)
            : Effect.void
        })

        const attempt = Effect.gen(function* () {
          // EVERY request plans a NEW page (a fresh canvas in the strip) —
          // earlier pages stay switchable. In-place refinement was the old
          // semantics and read as "nothing happened" on follow-ups.
          const initialEvents = yield* pageStore.list(args.conversationId).pipe(Effect.orDie)
          // Snapshot the COUNT now: a store may return a live array reference,
          // and comparing it to itself after the planner ran reads as "no
          // progress" forever (live-caught via the scripted twin).
          const initialCount = initialEvents.length
          const priorPages = foldPageEvents(initialEvents).length
          const pageOpenedGoal = goalReached(() =>
            pageStore.list(args.conversationId).pipe(Effect.orDie, Effect.map((events) => events.length > initialCount)))
          const pageCompleteGoal = goalReached(() =>
            pageStore.list(args.conversationId).pipe(Effect.orDie, Effect.map((events) => foldPageEvents(events).at(-1)?.complete === true)))
          yield* runStage(
            "planner",
            uiPlannerPrompt(promptContract, protocol),
            priorPages === 0
              ? text
              : `${text}\n\n(Open a NEW page for this request with start_ui — a fresh kebab-case page id, never one already in use.)`,
            pageOpenedGoal,
          )

          const plannedEvents = yield* pageStore.list(args.conversationId).pipe(Effect.orDie)
          const plannedPage = plannedEvents.length > initialCount ? foldPageEvents(plannedEvents).at(-1) : undefined
          const page = plannedPage === undefined
            ? yield* repair("planner", text, undefined, pageOpenedGoal).pipe(
              Effect.zipRight(pageStore.list(args.conversationId).pipe(Effect.orDie)),
              Effect.map((repairedEvents) => repairedEvents.length > initialCount ? foldPageEvents(repairedEvents).at(-1) : undefined),
            )
            : plannedPage
          if (page === undefined) {
            yield* publish({
              type: "error",
              message: "The UI model did not produce an accepted page. Nothing was rendered.",
              failure: { code: "UiPageNotProduced", category: "validation", stage: "planner", message: "start_ui did not produce an accepted page", retryable: false },
            })
            return false
          }

          yield* Ref.set(rejectedRecords, [])
          const beforeComposition = plannedEvents.length
          yield* Ref.update(decoder, (state) => ({ ...state, sawDelta: false }))
          const composerWorkers = Math.max(1, profile.composer.workers ?? 1)
          const remaining = page.manifest.slots.filter((slot) => !page.blocks.some((block) => block.id === slot.id)).map((slot) => slot.id)
          yield* composerWorkers > 1 && remaining.length >= 2
            ? runComposerFleet(page, Math.min(composerWorkers, remaining.length), remaining, pageCompleteGoal)
            : runStage(
              "composer",
              uiComposerPrompt(promptContract, protocol),
              `[request]\n${text}\n\n[accepted-page]\n${JSON.stringify(page)}\n\nComplete the LLM-generated page with specific, useful content in one patch_ui call.`,
              pageCompleteGoal,
            )
          const composedEvents = yield* pageStore.list(args.conversationId).pipe(Effect.orDie)
          const composedPage = foldPageEvents(composedEvents).at(-1)
          const acceptedBeforeRepair = composedEvents.length > beforeComposition && composedPage?.complete === true
          const accepted = acceptedBeforeRepair
            ? true
            : yield* repair("composer", text, composedPage, pageCompleteGoal).pipe(
              Effect.zipRight(pageStore.list(args.conversationId).pipe(Effect.orDie)),
              Effect.map((repairedEvents) => repairedEvents.length > beforeComposition && foldPageEvents(repairedEvents).at(-1)?.complete === true),
            )
          if (!accepted) {
            yield* publish({
              type: "error",
              message: "The UI model did not complete an accepted content patch.",
              failure: { code: "UiPatchNotCompleted", category: "validation", stage: "composer", message: "patch_ui did not produce an accepted complete page", retryable: false },
            })
          }
          return accepted
        }).pipe(
          Effect.flatMap((accepted) => publish({ type: "agent_end", outcome: accepted ? "ok" : "partial", reason: accepted ? "completed" : "step-cap", finalText: "" })),
          Effect.catchAllCause((cause) => publish({ type: "error", message: `UI generation failed: ${String(cause)}` }).pipe(
            Effect.zipRight(publish({ type: "agent_end", outcome: "partial", reason: "step-cap", finalText: "" })),
          )),
          Effect.onInterrupt(() => publish({ type: "agent_end", outcome: "partial", reason: "step-cap", finalText: "" })),
          Effect.ensuring(Ref.set(activeAttempt, Option.none())),
        )
        // THE ATTEMPT HARD CAP (#118): every stage is individually bounded,
        // yet ~11% of campaign trials still capped with NO agent_end — the
        // wedge sits between/above stages where no deadline reaches. The cap
        // is the sum of every stage deadline plus margin; on cap the session
        // publishes an honest failure + agent_end and ABANDONS the attempt
        // (disconnected — a wedged runtime must never hold the cap hostage).
        const attemptCapMs = stageDeadlineTotalMs + 12_000
        const capped = Effect.race(
          Effect.disconnect(attempt),
          Effect.sleep(Duration.millis(attemptCapMs)).pipe(
            Effect.zipRight(publish({
              type: "error",
              message: `The UI attempt exceeded its ${attemptCapMs}ms hard cap and was abandoned — blocks already accepted remain on the page.`,
              failure: { code: "UiAttemptCapExceeded", category: "timeout", stage: "attempt", message: `no agent_end within ${attemptCapMs}ms`, retryable: true },
            })),
            Effect.zipRight(publish({ type: "agent_end", outcome: "partial", reason: "step-cap", finalText: "" })),
            Effect.zipRight(Ref.set(activeAttempt, Option.none())),
          ),
        )
        const fiber = yield* Effect.forkDaemon(capped)
        yield* Ref.set(activeAttempt, Option.some(fiber))
      }),
    })

    return {
      ...session,
      interrupt: interruptAttempt.pipe(Effect.zipRight(session.interrupt)),
      shutdown: interruptAttempt.pipe(Effect.zipRight(session.shutdown)),
    }
  })
