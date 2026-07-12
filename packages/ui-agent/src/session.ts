import { LanguageModel } from "@effect/ai"
import { Duration, Effect, Fiber, Option, Ref } from "effect"
import { ConversationStore, makeSession, runAgent, toAgentFailure } from "@xandreed/engine"
import type { ConversationId, LoopEvent, Session } from "@xandreed/engine"
import { foldPageEvents } from "./domain/ui-page.entity.functions.js"
import { UiAgentExecutionProfile, UiAgentModels } from "./ports/ui-agent-runtime.port.js"
import { UiHost } from "./ports/ui-host.port.js"
import { UiPageStore } from "./ports/ui-page-store.port.js"
import { makeUiAgentHandlers, uiAgentToolkit } from "./toolkit.js"
import { uiComposerPrompt, uiPlannerPrompt } from "./prompts.js"

export type UiAgentEvent = LoopEvent | import("./domain/ui-page.entity.js").UiPageEvent
export type UiAgentSession = Session<UiAgentEvent>
export type UiAgentRunServices = ConversationStore | UiPageStore | UiHost | UiAgentModels | UiAgentExecutionProfile

export const makeUiAgentSession = (args: { readonly conversationId: ConversationId }): Effect.Effect<UiAgentSession, never, UiAgentRunServices> =>
  Effect.gen(function* () {
    const conversationStore = yield* ConversationStore
    const pageStore = yield* UiPageStore
    const host = yield* UiHost
    const models = yield* UiAgentModels
    const profile = yield* UiAgentExecutionProfile
    const capabilities = [...host.actions.keys(), ...host.queries.keys()]
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
        const handlers = makeUiAgentHandlers(args.conversationId, pageStore, host, publish)
        const stagePublish = (event: LoopEvent): Effect.Effect<void> =>
          event.type === "turn_start" || event.type === "agent_end" ? Effect.void : publish(event)
        const publishFailure = (stage: "planner" | "composer", error: unknown) => {
          const failure = toAgentFailure(error, stage)
          return Effect.logWarning(`UI ${stage} failed within its ${profile[stage].timeoutMs}ms budget: [${failure.code}] ${failure.message}`).pipe(
            Effect.zipRight(publish({ type: "error", message: `UI ${stage} failed: ${failure.message}`, failure })),
          )
        }
        const attemptConversationId = yield* conversationStore.create(`ui-attempt:${args.conversationId}`).pipe(Effect.orDie)

        const attempt = Effect.gen(function* () {
          const initialEvents = yield* pageStore.list(args.conversationId).pipe(Effect.orDie)
          if (foldPageEvents(initialEvents).length === 0) {
            yield* runAgent(
              { system: uiPlannerPrompt(capabilities), toolkit: uiAgentToolkit, maxSteps: profile.planner.maxSteps, toolConcurrency: 1, streaming: true, modelPolicy: { effort: profile.planner.effort, maxOutputTokens: profile.planner.maxOutputTokens } },
              attemptConversationId,
              text,
              { onEvent: stagePublish },
            ).pipe(
              Effect.provideService(LanguageModel.LanguageModel, models.planner),
              Effect.timeout(Duration.millis(profile.planner.timeoutMs)),
              Effect.catchAll((error) => publishFailure("planner", error)),
              Effect.provide(handlers),
            )
          }

          const plannedEvents = yield* pageStore.list(args.conversationId).pipe(Effect.orDie)
          const page = foldPageEvents(plannedEvents).at(-1)
          if (page === undefined) {
            yield* publish({
              type: "error",
              message: "The UI model did not produce an accepted page. Nothing was rendered.",
              failure: { code: "UiPageNotProduced", category: "validation", stage: "planner", message: "start_ui did not produce an accepted page", retryable: false },
            })
            return false
          }

          const beforeComposition = plannedEvents.length
          yield* runAgent(
            { system: uiComposerPrompt(capabilities), toolkit: uiAgentToolkit, maxSteps: profile.composer.maxSteps, toolConcurrency: 1, streaming: true, modelPolicy: { effort: profile.composer.effort, maxOutputTokens: profile.composer.maxOutputTokens } },
            attemptConversationId,
            `[request]\n${text}\n\n[accepted-page]\n${JSON.stringify(page)}\n\nComplete the LLM-generated page with specific, useful content in one patch_ui call.`,
            { onEvent: stagePublish },
          ).pipe(
            Effect.provideService(LanguageModel.LanguageModel, models.composer),
            Effect.timeout(Duration.millis(profile.composer.timeoutMs)),
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
