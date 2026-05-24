import { Effect, pipe } from "effect"
import {
  type AgentHooks,
  type AgentMessage,
  type AgentResult,
  type AgentTool,
  type LlmCacheHint,
  type ToolCall,
  Llm,
  LlmError,
} from "@agent/core"

/**
 * Provider-agnostic agent loop. Drives turns through `Llm.runTurn` via a
 * pipeline of `LoopState => Effect<LoopState>` step functions composed
 * with `Effect.flatMap`, iterated by `Effect.iterate`.
 *
 * The loop is pure state-shaping over `LoopState`. It never inspects
 * `AgentMessage` content parts — `assistantText` and `toolCalls` arrive
 * pre-extracted from the port (see `vercel-ai.ts`). Step functions live
 * at module level; per-run state (system, tools, hooks, cache) is bundled
 * into a `LoopCtx` and partially applied once when the pipeline is built.
 */

type LoopState = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly turnIndex: number
  readonly lastFinishReason: string | undefined
  /** Text the assistant emitted on the most recent turn (may be empty). */
  readonly lastTurnAssistantText: string
  /** Tool calls the assistant emitted on the most recent turn. */
  readonly lastTurnToolCalls: ReadonlyArray<ToolCall>
  /** Running last non-empty assistant text — the agent's final answer. */
  readonly finalText: string
  readonly stopRequested: boolean
}

type LoopCtx<R> = {
  readonly system: string
  readonly tools: ReadonlyArray<AgentTool<any, any, R>>
  readonly maxSteps: number
  readonly hooks?: AgentHooks<R>
  readonly cacheHint?: LlmCacheHint
}

export interface RunAgentLoopInput<R> {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<AgentTool<any, any, R>>
  readonly maxSteps?: number
  readonly hooks?: AgentHooks<R>
  /** Opaque per-conversation cache hint from a prior `Llm.snapshot`,
   * threaded into every `runTurn`. */
  readonly cacheHint?: LlmCacheHint
}

// ---- Step functions (module-level, partially applied with ctx) ----

const applyTransformContext =
  <R>(ctx: LoopCtx<R>) =>
  (s: LoopState): Effect.Effect<LoopState, never, R> => {
    const hook = ctx.hooks?.onTransformContext
    if (!hook) return Effect.succeed(s)
    return hook(s.messages).pipe(
      Effect.map((transformed) =>
        transformed === s.messages ? s : { ...s, messages: transformed },
      ),
    )
  }

const emitTurnStart =
  <R>(ctx: LoopCtx<R>) =>
  (s: LoopState): Effect.Effect<LoopState, never, R> => {
    const hook = ctx.hooks?.onTurnStart
    if (!hook) return Effect.succeed(s)
    return hook({ turnIndex: s.turnIndex, messages: s.messages }).pipe(
      Effect.as(s),
    )
  }

const takeTurn =
  <R>(ctx: LoopCtx<R>) =>
  (s: LoopState): Effect.Effect<LoopState, LlmError, R | Llm> =>
    Effect.gen(function* () {
      const llm = yield* Llm
      const result = yield* llm.runTurn({
        system: ctx.system,
        messages: s.messages,
        tools: ctx.tools,
        turnIndex: s.turnIndex,
        ...(ctx.hooks !== undefined ? { hooks: ctx.hooks } : {}),
        ...(ctx.cacheHint !== undefined ? { cacheHint: ctx.cacheHint } : {}),
      })
      return {
        ...s,
        messages: [...s.messages, ...result.newMessages],
        lastFinishReason: result.finishReason,
        lastTurnAssistantText: result.assistantText,
        lastTurnToolCalls: result.toolCalls,
        finalText:
          result.assistantText.length > 0 ? result.assistantText : s.finalText,
      }
    })

const emitAssistantMessage =
  <R>(ctx: LoopCtx<R>) =>
  (s: LoopState): Effect.Effect<LoopState, never, R> => {
    const hook = ctx.hooks?.onAssistantMessage
    if (!hook) return Effect.succeed(s)
    return hook({
      turnIndex: s.turnIndex,
      text: s.lastTurnAssistantText,
      toolCalls: s.lastTurnToolCalls,
    }).pipe(Effect.as(s))
  }

const decideContinuation =
  <R>(_ctx: LoopCtx<R>) =>
  (s: LoopState): Effect.Effect<LoopState, never, R> =>
    Effect.succeed({
      ...s,
      // Continue iff the model both signalled more tool work AND actually
      // emitted at least one tool call this turn.
      stopRequested:
        s.lastFinishReason !== "tool-calls" || s.lastTurnToolCalls.length === 0,
    })

const consultShouldStop =
  <R>(ctx: LoopCtx<R>) =>
  (s: LoopState): Effect.Effect<LoopState, never, R> => {
    if (s.stopRequested) return Effect.succeed(s)
    const hook = ctx.hooks?.onShouldStopAfterTurn
    if (!hook) return Effect.succeed(s)
    return hook({
      turnIndex: s.turnIndex,
      finishReason: s.lastFinishReason ?? "",
    }).pipe(Effect.map((stop) => (stop ? { ...s, stopRequested: true } : s)))
  }

const advanceTurn =
  <R>(_ctx: LoopCtx<R>) =>
  (s: LoopState): Effect.Effect<LoopState, never, R> =>
    Effect.succeed({ ...s, turnIndex: s.turnIndex + 1 })

const turnPipeline =
  <R>(ctx: LoopCtx<R>) =>
  (s: LoopState): Effect.Effect<LoopState, LlmError, R | Llm> =>
    pipe(
      Effect.succeed(s),
      Effect.flatMap(applyTransformContext(ctx)),
      Effect.flatMap(emitTurnStart(ctx)),
      Effect.flatMap(takeTurn(ctx)),
      Effect.flatMap(emitAssistantMessage(ctx)),
      Effect.flatMap(decideContinuation(ctx)),
      Effect.flatMap(consultShouldStop(ctx)),
      Effect.flatMap(advanceTurn(ctx)),
    )

// ---- Entry point ----

export const runAgentLoop = <R>(
  input: RunAgentLoopInput<R>,
): Effect.Effect<AgentResult, LlmError, R | Llm> => {
  const ctx: LoopCtx<R> = {
    system: input.system,
    tools: input.tools,
    maxSteps: input.maxSteps ?? 5,
    ...(input.hooks !== undefined ? { hooks: input.hooks } : {}),
    ...(input.cacheHint !== undefined ? { cacheHint: input.cacheHint } : {}),
  }

  const initialState: LoopState = {
    messages: input.messages,
    turnIndex: 0,
    lastFinishReason: undefined,
    lastTurnAssistantText: "",
    lastTurnToolCalls: [],
    finalText: "",
    stopRequested: false,
  }

  return pipe(
    Effect.iterate(initialState, {
      while: (s: LoopState) => !s.stopRequested && s.turnIndex < ctx.maxSteps,
      body: turnPipeline(ctx),
    }),
    Effect.tap((s) =>
      ctx.hooks?.onAgentEnd
        ? ctx.hooks.onAgentEnd({
            messages: s.messages,
            finalText: s.finalText,
          })
        : Effect.void,
    ),
    Effect.map(
      (s): AgentResult => ({ finalText: s.finalText, messages: s.messages }),
    ),
  )
}
