import { LanguageModel } from "@effect/ai"
import { Duration, Effect, Fiber, Option, Ref } from "effect"
import { ConversationStore, makeSession, runAgent, toAgentFailure, toolResultFailure } from "@xandreed/engine"
import type { ConversationId, LoopEvent, Session } from "@xandreed/engine"
import { foldPageEvents } from "./domain/ui-page.entity.functions.js"
import { UiAgentExecutionProfile, UiAgentModels } from "./ports/ui-agent-runtime.port.js"
import { UiHost } from "./ports/ui-host.port.js"
import { UiPageStore } from "./ports/ui-page-store.port.js"
import { UiComponentCatalog } from "./ports/ui-component-catalog.port.js"
import { UiThemeStore } from "./ports/ui-theme-store.port.js"
import type { UiComponentCatalogService } from "./ports/ui-component-catalog.port.js"
import type { UiThemeStoreService } from "./ports/ui-theme-store.port.js"
import { makeUiAgentHandlers, uiAgentToolkit } from "./toolkit.js"
import { uiComposerPrompt, uiPlannerPrompt } from "./prompts.js"
import { admitComponent, retrieveComponents, componentPromptLine } from "./domain/ui-component.entity.functions.js"
import { CORE_UI_COMPONENTS } from "./domain/core-components.functions.js"
import { decodeUiProtocolChunk, emptyUiProtocolDecoderState } from "./domain/ui-generation-protocol.entity.functions.js"
import type { UiProtocolRecord } from "./domain/ui-generation-protocol.entity.js"

export type UiAgentEvent = LoopEvent | import("./domain/ui-page.entity.js").UiPageEvent
export type UiAgentSession = Session<UiAgentEvent>
export type UiAgentRunServices = ConversationStore | UiPageStore | UiHost | UiAgentModels | UiAgentExecutionProfile

const defaultCatalog: UiComponentCatalogService = {
  list: Effect.succeed(CORE_UI_COMPONENTS),
  admit: (definition) => Effect.succeed(admitComponent(definition, CORE_UI_COMPONENTS)),
  recordUsage: () => Effect.void,
  usages: () => Effect.succeed([]),
}

const defaultThemes: UiThemeStoreService = { list: Effect.succeed([]), put: () => Effect.void }

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
        const stagePublish = (event: LoopEvent): Effect.Effect<void> => {
          if (event.type === "turn_start" || event.type === "agent_end") return Effect.void
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
        const stageDeadline = (stage: "planner" | "composer"): Duration.Duration =>
          Duration.millis(Math.min(profile[stage].timeoutMs * 3, 55_000))
        const publishFailure = (stage: "planner" | "composer", error: unknown) => {
          const failure = toAgentFailure(error, stage)
          return Effect.logWarning(`UI ${stage} gave up after ${Duration.toMillis(stageDeadline(stage))}ms (3x the ${profile[stage].timeoutMs}ms budget): [${failure.code}] ${failure.message}`).pipe(
            Effect.zipRight(publish({ type: "error", message: `UI ${stage} failed after an extended wait: ${failure.message} — any blocks already accepted remain on the page`, failure })),
          )
        }
        const attemptConversationId = yield* conversationStore.create(`ui-attempt:${args.conversationId}`).pipe(Effect.orDie)

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
          yield* runAgent(
            { system: uiPlannerPrompt(promptContract, protocol), toolkit: uiAgentToolkit, maxSteps: profile.planner.maxSteps, toolConcurrency: 1, streaming: true, modelPolicy: { effort: profile.planner.effort, maxOutputTokens: profile.planner.maxOutputTokens } },
            attemptConversationId,
            priorPages === 0
              ? text
              : `${text}\n\n(Open a NEW page for this request with start_ui — a fresh kebab-case page id, never one already in use.)`,
            { onEvent: stagePublish },
          ).pipe(
            Effect.provideService(LanguageModel.LanguageModel, models.planner),
            Effect.timeout(stageDeadline("planner")),
            Effect.catchAll((error) => publishFailure("planner", error)),
            Effect.provide(handlers),
          )

          const plannedEvents = yield* pageStore.list(args.conversationId).pipe(Effect.orDie)
          const page = plannedEvents.length > initialCount ? foldPageEvents(plannedEvents).at(-1) : undefined
          if (page === undefined) {
            yield* publish({
              type: "error",
              message: "The UI model did not produce an accepted page. Nothing was rendered.",
              failure: { code: "UiPageNotProduced", category: "validation", stage: "planner", message: "start_ui did not produce an accepted page", retryable: false },
            })
            return false
          }

          const beforeComposition = plannedEvents.length
          yield* Ref.update(decoder, (state) => ({ ...state, sawDelta: false }))
          yield* runAgent(
            { system: uiComposerPrompt(promptContract, protocol), toolkit: uiAgentToolkit, maxSteps: profile.composer.maxSteps, toolConcurrency: 1, streaming: true, modelPolicy: { effort: profile.composer.effort, maxOutputTokens: profile.composer.maxOutputTokens } },
            attemptConversationId,
            `[request]\n${text}\n\n[accepted-page]\n${JSON.stringify(page)}\n\nComplete the LLM-generated page with specific, useful content in one patch_ui call.`,
            { onEvent: stagePublish },
          ).pipe(
            Effect.provideService(LanguageModel.LanguageModel, models.composer),
            Effect.timeout(stageDeadline("composer")),
            Effect.catchAll((error) => publishFailure("composer", error)),
            Effect.provide(handlers),
          )
          const composedEvents = yield* pageStore.list(args.conversationId).pipe(Effect.orDie)
          const composedPage = foldPageEvents(composedEvents).at(-1)
          const accepted = composedEvents.length > beforeComposition && composedPage?.complete === true
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
        const fiber = yield* Effect.forkDaemon(attempt)
        yield* Ref.set(activeAttempt, Option.some(fiber))
      }),
    })

    return {
      ...session,
      interrupt: interruptAttempt.pipe(Effect.zipRight(session.interrupt)),
      shutdown: interruptAttempt.pipe(Effect.zipRight(session.shutdown)),
    }
  })
