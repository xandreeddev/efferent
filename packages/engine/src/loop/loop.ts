import { LanguageModel, Prompt } from "@effect/ai"
import type { Tool, Toolkit } from "@effect/ai"
import { Effect, Match, Metric, Option, Ref, Stream } from "effect"
import { foldStreamParts } from "./streamFold.js"
import { CurrentEmptyResponseTolerance } from "./modelPolicy.js"
import type { LoopEvent } from "../domain/loop-event.entity.js"
import type { AgentMessage, AgentResult } from "../domain/message.entity.js"
import { addUsage, zeroUsage } from "../domain/token-usage.entity.functions.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import {
  extractModel,
  extractUsage,
  handoffToMessage,
  responseReasoning,
  responseText,
  responseToAgentMessages,
  responseToolCalls,
  responseToolResults,
  toPromptMessages,
  withToolCallIds,
  withUsageOnAssistant,
} from "./mapping.js"

/**
 * A mid-run fold the `compact` callback hands back: everything before
 * `keepFrom` is replaced by `handoffToMessage(summary)`; `messages[keepFrom..]`
 * survive verbatim. CONTRACT: `keepFrom` must index an assistant message
 * (never split a tool-call from its results) — `safeKeepFrom` guarantees it;
 * the loop ignores a plan that violates the contract (the run continues
 * unfolded, best-effort).
 */
export interface CompactionPlan {
  readonly summary: string
  readonly keepFrom: number
}

/**
 * The provider-agnostic agent loop. `@effect/ai` resolves ONE step's tool
 * calls (its handlers are our Effects) but does not iterate across turns —
 * iteration is ours: each turn maps the message buffer to a `Prompt`, calls
 * `LanguageModel.generateText`, appends the response as the new tail, and
 * re-invokes until the model stops requesting tools, `maxSteps` is hit, or
 * the degenerate-loop breaker fires. State is an immutable fold through
 * `Effect.iterate` — the same discipline as foundry's forge loop.
 */

export interface RunLoopOptions<Tools extends Record<string, Tool.Any>, R> {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly toolkit: Toolkit.Toolkit<Tools>
  /** A ceiling, not a target — a normal run ends when the model stops
   *  calling tools. Default {@link DEFAULT_MAX_STEPS}. */
  readonly maxSteps?: number
  /** Concurrency for resolving one step's tool calls. Default
   *  {@link DEFAULT_TOOL_CONCURRENCY} — bounded so a many-call turn doesn't
   *  stampede the provider. */
  readonly toolConcurrency?: number
  /** Tools designed to be POLLED — repeat calls with unchanged results are
   *  correct for these, so they never count toward the degenerate breaker. */
  readonly pollableTools?: ReadonlyArray<string>
  /** The single event sink — see `LoopEvent`. */
  readonly onEvent?: (event: LoopEvent) => Effect.Effect<void, never, R>
  /**
   * Incremental persistence: called with each turn's appended messages
   * (model responses AND synthetic correctives) the moment they land, so a
   * session is restorable to its last completed turn after a crash. Returns
   * the absolute store positions aligned with the input.
   */
  readonly onTail?: (
    messages: ReadonlyArray<AgentMessage>,
  ) => Effect.Effect<ReadonlyArray<number>, never, R>
  /**
   * The WITHIN-RUN compaction seam, consulted at turn boundaries while the
   * run continues. Receives the buffer the NEXT turn would send plus the
   * just-finished turn's usage (its `inputTokens` IS the live context cost);
   * `Some(plan)` rewrites the buffer to summary + kept tail. The loop stays
   * pure — the callback owns thresholds, summarization, and persistence.
   */
  readonly compact?: (
    messages: ReadonlyArray<AgentMessage>,
    lastTurnUsage: TokenUsage,
  ) => Effect.Effect<Option.Option<CompactionPlan>, never, R>
  /**
   * Route turns through `streamText`, folding the parts back into the
   * settled turn shape while fanning `assistant_delta` events as tokens
   * flow. Default FALSE. A stream that fails before its first part
   * (scripted providers' `Stream.die` included) falls back to
   * `generateText` transparently — for the REST of the run, not per turn.
   */
  readonly streaming?: boolean
  /**
   * MID-TURN steering, consulted at turn boundaries while the run
   * continues (the `compact` seam's twin): `Some(text)` appends a user
   * message the NEXT model call sees — a human's course correction lands
   * at the next step instead of after the whole run. Injected after any
   * fold (steering must never be compacted away) and persisted via
   * `onTail` like every other appended message.
   */
  readonly pendingInput?: () => Effect.Effect<Option.Option<string>, never, R>
}

export const DEFAULT_MAX_STEPS = 100
export const DEFAULT_TOOL_CONCURRENCY = 4

/**
 * The loop's own quality metrics (Day-4 "trajectory efficiency" vitals) —
 * pure `effect` Metric, exported to Prometheus by providers' TracingLive:
 * `engine_runs_total{engine_outcome,engine_reason}` (task completion rate),
 * `engine_tool_calls_total{engine_tool,engine_ok}` (usage frequency +
 * failed-call rate), `engine_corrections_total{engine_kind}` (malformed
 * recoveries and degenerate nudges — the self-correction count).
 */
const engineRuns = Metric.counter("engine.runs", {
  description: "agent runs by outcome and reason",
  incremental: true,
})
const engineToolCalls = Metric.counter("engine.tool_calls", {
  description: "tool calls by tool name and result",
  incremental: true,
})
const engineCorrections = Metric.counter("engine.corrections", {
  description: "self-corrections by kind (malformed recovery, degenerate nudge)",
  incremental: true,
})
const tagged = <Type, In, Out>(
  metric: Metric.Metric<Type, In, Out>,
  tags: Record<string, string>,
): Metric.Metric<Type, In, Out> =>
  Object.entries(tags).reduce((m, [key, value]) => Metric.tagged(m, key, value), metric)

/** Consecutive malformed responses tolerated before the run fails for real. */
const MAX_MALFORMED = 3

/** Consecutive no-progress turns before the breaker nudges, then force-stops. */
const REPEAT_NUDGE_AT = 3
const REPEAT_BREAK_AT = 5

export const DEGENERATE_REPEAT_NUDGE =
  "You've called the same tool(s) and gotten the same result several times in " +
  "a row — you're looping without making progress. STOP repeating that call. " +
  "Take a DIFFERENT concrete action toward the task; if you're genuinely " +
  "stuck, say what's blocking you and stop."

export const DEGENERATE_LOOP_STOP =
  "[stopped: repeated the same tool call with no progress — the run was looping]"

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}…`)

/**
 * A stable signature of one turn's PROGRESS — the sorted multiset of each
 * non-pollable tool's `name:ok:result`. Keyed on the RESULT, not the args: a
 * tool that returns the same thing regardless of its args registers as no
 * progress even when the model churns the arguments. Empty string = the turn
 * must not count (no tool calls, or purely pollable ones).
 */
const progressSignature = (
  content: ReadonlyArray<unknown>,
  pollable: ReadonlySet<string>,
): string => {
  const calls = responseToolCalls(content)
  if (calls.length === 0) return ""
  if (calls.every((c) => pollable.has(c.toolName))) return ""
  return responseToolResults(content)
    .filter((r) => !pollable.has(r.toolName))
    .map((r) => `${r.toolName}:${r.ok ? "ok" : "err"}:${clip(JSON.stringify(r.result ?? null), 300)}`)
    .sort()
    .join("|")
}

type Phase = "continue" | "completed" | "step-cap" | "degenerate-loop"

interface LoopState {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly newTail: ReadonlyArray<AgentMessage>
  readonly finalText: string
  readonly turnIndex: number
  readonly malformedStreak: number
  readonly seen: ReadonlySet<string>
  readonly staleTurns: number
  readonly usage: TokenUsage
  readonly phase: Phase
  /** Trajectory vitals — annotated on the run span at the end. */
  readonly toolCalls: number
  readonly toolFailures: number
  readonly corrections: number
  /** Flips false after a pre-first-part stream failure — the rest of the
   *  run goes straight to `generateText`, no per-turn re-probe. */
  readonly streamingHealthy: boolean
}

export const runLoop = <Tools extends Record<string, Tool.Any>, R = never>(
  options: RunLoopOptions<Tools, R>,
) =>
  Effect.gen(function* () {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    const pollable: ReadonlySet<string> = new Set(options.pollableTools ?? [])
    const onEvent = options.onEvent ?? (() => Effect.void)
    // Resolve the toolkit's handlers once — they're stable across turns.
    const toolkit = yield* options.toolkit
    const toolNames = Object.keys(toolkit.tools)

    const step = (state: LoopState) =>
      Effect.gen(function* () {
        yield* onEvent({ type: "turn_start", turnIndex: state.turnIndex })

        const prompt = Prompt.make([
          { role: "system", content: options.system },
          ...toPromptMessages(state.messages),
        ] as never)

        const callOptions = {
          prompt,
          toolkit,
          concurrency: options.toolConcurrency ?? DEFAULT_TOOL_CONCURRENCY,
        }

        /** Both paths land on the SAME settled shape — after this point the
         *  turn body is identical code, streamed or not. */
        const settled = (streamingHealthy: boolean) =>
          LanguageModel.generateText(callOptions).pipe(
            Effect.map((res) => ({
              _tag: "ok" as const,
              content: res.content as ReadonlyArray<unknown>,
              finishReason: res.finishReason as string,
              usage: res.usage as unknown,
              streamingHealthy,
            })),
          )

        // The streamed twin: fold parts into the settled shape, fanning
        // assistant_delta events while tokens flow. A failure or defect
        // BEFORE the first part (a scripted provider's Stream.die, a broken
        // gateway) falls back to generateText for the rest of the run;
        // after the first part, failures ride the existing turn handling
        // (tool handlers may already have run — a replay would duplicate).
        const streamed = Effect.gen(function* () {
          const partSeen = yield* Ref.make(false)
          const folded = yield* foldStreamParts(
            LanguageModel.streamText(callOptions).pipe(
              Stream.tap(() => Ref.set(partSeen, true)),
            ),
            (delta) =>
              onEvent({
                type: "assistant_delta",
                turnIndex: state.turnIndex,
                channel: delta.channel,
                id: delta.id,
                delta: delta.delta,
              }),
          ).pipe(
            Effect.map((turn) =>
              Option.some({
                _tag: "ok" as const,
                content: turn.content,
                finishReason: turn.finishReason,
                usage: turn.usage,
                streamingHealthy: true,
              }),
            ),
            Effect.catchAll((err) =>
              Ref.get(partSeen).pipe(
                Effect.flatMap((armed) =>
                  armed ? Effect.fail(err) : Effect.succeed(Option.none<never>()),
                ),
              ),
            ),
            Effect.catchAllDefect((defect) =>
              Ref.get(partSeen).pipe(
                Effect.flatMap((armed) =>
                  armed ? Effect.die(defect) : Effect.succeed(Option.none<never>()),
                ),
              ),
            ),
          )
          return yield* Option.match(folded, {
            onSome: Effect.succeed,
            onNone: () =>
              Effect.logWarning(
                "streaming failed before any part arrived — falling back to generateText for this run",
              ).pipe(Effect.zipRight(settled(false))),
          })
        })

        const useStreaming = options.streaming === true && state.streamingHealthy
        const outcome = yield* (useStreaming ? streamed : settled(state.streamingHealthy)).pipe(
          Effect.catchAll((err) =>
            (err as { readonly _tag?: string } | null)?._tag === "MalformedOutput"
              ? Effect.succeed({ _tag: "malformed" as const, err })
              : Effect.fail(err),
          ),
          // Once the run has tool calls, a following empty response is the
          // model saying "done" — adapters must return it (the fold below
          // ends the turn) instead of rejecting it into the patient outage
          // ladder, which parks the turn until a deadline kills it.
          Effect.locally(CurrentEmptyResponseTolerance, state.toolCalls > 0),
          Effect.withSpan("engine.turn", {
            attributes: { "engine.turn": state.turnIndex },
          }),
        )

        // A response that doesn't decode — a hallucinated tool NAME or a
        // wrong-shaped param set (both fail inside generateText, before any
        // handler runs, so `failureMode: "return"` never sees them): feed the
        // decode error back as a corrective turn and retry, bounded.
        if (outcome._tag === "malformed") {
          const streak = state.malformedStreak + 1
          if (streak >= MAX_MALFORMED) return yield* Effect.fail(outcome.err)
          const desc = clip(
            String(
              (outcome.err as { readonly description?: unknown }).description ??
                "the response could not be parsed",
            ),
            600,
          )
          yield* Effect.logWarning(`recovering from a malformed response: ${desc}`)
          yield* Metric.increment(tagged(engineCorrections, { "engine.kind": "malformed" }))
          const corrective: AgentMessage = {
            role: "user",
            content:
              `Your previous reply could not be parsed: ${desc}\n\n` +
              `This usually means you called a tool that doesn't exist or used the ` +
              `wrong argument shape. The only tools available are: ${toolNames.join(", ")}. ` +
              `Reply again using one of those tools, or plain text if you're done.`,
          }
          yield* options.onTail?.([corrective]) ?? Effect.void
          return {
            ...state,
            messages: [...state.messages, corrective],
            newTail: [...state.newTail, corrective],
            turnIndex: state.turnIndex + 1,
            malformedStreak: streak,
            corrections: state.corrections + 1,
          } satisfies LoopState
        }

        // Mint deterministic ids for id-less tool calls BEFORE the content
        // fans out into events + persisted messages (durable UI identity).
        const content = withToolCallIds(outcome.content, state.turnIndex)
        const usage = extractUsage(outcome.usage, content)
        const model = extractModel(content)
        const tail = withUsageOnAssistant(responseToAgentMessages(content), usage, model)
        // Persist BEFORE the events fire so the assistant message's durable
        // position is known when its event is emitted (UIs key on it).
        const positions = yield* options.onTail?.(tail) ?? Effect.succeed([])
        const assistantAt = tail.findIndex((m) => m.role === "assistant")
        const assistantPosition =
          assistantAt >= 0 ? Option.fromNullable(positions[assistantAt]) : Option.none<number>()

        const text = responseText(content)
        const toolCalls = responseToolCalls(content)
        yield* onEvent({
          type: "assistant_message",
          turnIndex: state.turnIndex,
          text,
          reasoning: responseReasoning(content),
          toolCalls,
          usage,
          ...Option.match(model, { onNone: () => ({}), onSome: (id) => ({ model: id }) }),
          ...Option.match(assistantPosition, {
            onNone: () => ({}),
            onSome: (position) => ({ position }),
          }),
        })
        const argsByCallId = new Map(toolCalls.map((tc) => [tc.id, tc.args]))
        yield* Effect.forEach(toolCalls, (tc) =>
          onEvent({
            type: "tool_start",
            turnIndex: state.turnIndex,
            toolCallId: tc.id,
            toolName: tc.toolName,
            args: tc.args,
          }),
        )
        const toolResults = responseToolResults(content)
        yield* Effect.forEach(toolResults, (tr) =>
          onEvent({
            type: "tool_end",
            turnIndex: state.turnIndex,
            toolCallId: tr.id,
            toolName: tr.toolName,
            args: argsByCallId.get(tr.id) ?? {},
            ok: tr.ok,
            result: tr.result,
          }).pipe(
            Effect.zipRight(
              Metric.increment(
                tagged(engineToolCalls, {
                  "engine.tool": tr.toolName,
                  "engine.ok": tr.ok ? "true" : "false",
                }),
              ),
            ),
          ),
        )

        // --- Degenerate-loop circuit breaker ---
        // A turn whose progress signature was already seen produced nothing
        // new; count consecutive stale turns, nudge once, then force-stop.
        const sig = progressSignature(content, pollable)
        const stale = sig === "" ? state.staleTurns : state.seen.has(sig) ? state.staleTurns + 1 : 0
        const seen = sig === "" || state.seen.has(sig) ? state.seen : new Set([...state.seen, sig])
        const nudge: ReadonlyArray<AgentMessage> =
          sig !== "" && stale === REPEAT_NUDGE_AT
            ? [{ role: "user", content: DEGENERATE_REPEAT_NUDGE }]
            : []
        yield* nudge.length > 0 ? (options.onTail?.(nudge) ?? Effect.void) : Effect.void
        yield* nudge.length > 0
          ? Metric.increment(tagged(engineCorrections, { "engine.kind": "degenerate-nudge" }))
          : Effect.void

        const finalText = text.length > 0 ? text : state.finalText
        const turnIndex = state.turnIndex + 1
        const wantsMore = outcome.finishReason === "tool-calls" && toolCalls.length > 0
        const broke = sig !== "" && stale >= REPEAT_BREAK_AT
        const phase: Phase = broke
          ? "degenerate-loop"
          : !wantsMore
            ? "completed"
            : turnIndex >= maxSteps
              ? "step-cap"
              : "continue"
        yield* broke
          ? Effect.logWarning(`breaking a degenerate tool-call loop after ${stale} stale turns`)
          : Effect.void

        // --- Within-run compaction (turn boundaries only) ---
        // Consulted only while the run CONTINUES; the buffer rewrite is
        // load-side (persisted history and `newTail` untouched). A plan that
        // violates the assistant-boundary contract is ignored, never applied.
        const nextMessages = [...state.messages, ...tail, ...nudge]
        const plan =
          phase === "continue" && options.compact !== undefined
            ? yield* options.compact(nextMessages, usage)
            : Option.none<CompactionPlan>()
        const applied = Option.filter(
          plan,
          (p) =>
            p.keepFrom > 0 &&
            p.keepFrom < nextMessages.length &&
            nextMessages[p.keepFrom]?.role === "assistant",
        )
        yield* Option.match(applied, {
          onNone: () => Effect.void,
          onSome: (p) =>
            onEvent({
              type: "compaction",
              turnIndex: state.turnIndex,
              tokens: usage.inputTokens,
              kept: nextMessages.length - p.keepFrom,
            }),
        })

        // --- Mid-turn steering (turn boundaries, running runs only) ---
        // Consulted AFTER the fold so a steering message can never be
        // compacted away before the model sees it.
        const steered =
          phase === "continue" && options.pendingInput !== undefined
            ? yield* options.pendingInput()
            : Option.none<string>()
        const steerTail: ReadonlyArray<AgentMessage> = Option.match(steered, {
          onNone: () => [],
          onSome: (text) => [{ role: "user", content: text }],
        })
        yield* steerTail.length > 0 ? (options.onTail?.(steerTail) ?? Effect.void) : Effect.void

        return {
          messages: [
            ...Option.match(applied, {
              onNone: () => nextMessages,
              onSome: (p) => [handoffToMessage(p.summary), ...nextMessages.slice(p.keepFrom)],
            }),
            ...steerTail,
          ],
          newTail: [...state.newTail, ...tail, ...nudge, ...steerTail],
          finalText: broke && finalText.length === 0 ? DEGENERATE_LOOP_STOP : finalText,
          turnIndex,
          malformedStreak: 0,
          seen,
          staleTurns: stale,
          usage: addUsage(state.usage, usage),
          phase,
          toolCalls: state.toolCalls + toolCalls.length,
          toolFailures: state.toolFailures + toolResults.filter((tr) => !tr.ok).length,
          corrections: state.corrections + (nudge.length > 0 ? 1 : 0),
          streamingHealthy: outcome.streamingHealthy,
        } satisfies LoopState
      })

    const final = yield* Effect.iterate(
      {
        messages: options.messages,
        newTail: [],
        finalText: "",
        turnIndex: 0,
        malformedStreak: 0,
        seen: new Set<string>(),
        staleTurns: 0,
        usage: zeroUsage,
        phase: "continue",
        toolCalls: 0,
        toolFailures: 0,
        corrections: 0,
        streamingHealthy: true,
      } as LoopState,
      { while: (state) => state.phase === "continue", body: step },
    )

    const { outcome, reason } = Match.value(final.phase).pipe(
      Match.when("completed", () => ({ outcome: "ok" as const, reason: "completed" as const })),
      Match.when("step-cap", () => ({
        outcome: "partial" as const,
        reason: "step-cap" as const,
      })),
      Match.when("degenerate-loop", () => ({
        outcome: "partial" as const,
        reason: "degenerate-loop" as const,
      })),
      Match.when("continue", () => ({ outcome: "ok" as const, reason: "completed" as const })),
      Match.exhaustive,
    )
    yield* onEvent({ type: "agent_end", outcome, reason, finalText: final.finalText })
    yield* Metric.increment(
      tagged(engineRuns, { "engine.outcome": outcome, "engine.reason": reason }),
    )
    // The run span states its verdict AND its trajectory vitals — a
    // "completed" run with 25 steps, five failed calls, and three
    // corrections is a low-quality success visible at a glance (Day 4).
    yield* Effect.annotateCurrentSpan({
      "engine.outcome": outcome,
      "engine.reason": reason,
      "engine.turns": final.turnIndex,
      "engine.usage.total_tokens": final.usage.totalTokens,
      "engine.tool_calls": final.toolCalls,
      "engine.tool_calls.failed": final.toolFailures,
      "engine.corrections": final.corrections,
      error: outcome !== "ok",
    })
    return {
      finalText: final.finalText,
      messages: final.messages,
      newTail: final.newTail,
      outcome,
      reason,
    } satisfies AgentResult
  }).pipe(Effect.withSpan("engine.run"))
