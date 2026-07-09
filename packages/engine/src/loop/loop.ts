import { LanguageModel, Prompt } from "@effect/ai"
import type { Tool, Toolkit } from "@effect/ai"
import { Effect, Match, Option } from "effect"
import type { LoopEvent } from "../domain/LoopEvent.js"
import type { AgentMessage, AgentResult } from "../domain/Message.js"
import { addUsage, zeroUsage } from "../domain/TokenUsage.js"
import type { TokenUsage } from "../domain/TokenUsage.js"
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
}

export const DEFAULT_MAX_STEPS = 100
export const DEFAULT_TOOL_CONCURRENCY = 4

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

        const outcome = yield* LanguageModel.generateText({
          prompt,
          toolkit,
          concurrency: options.toolConcurrency ?? DEFAULT_TOOL_CONCURRENCY,
        }).pipe(
          Effect.map((res) => ({ _tag: "ok" as const, res })),
          Effect.catchAll((err) =>
            (err as { readonly _tag?: string } | null)?._tag === "MalformedOutput"
              ? Effect.succeed({ _tag: "malformed" as const, err })
              : Effect.fail(err),
          ),
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
          } satisfies LoopState
        }

        const res = outcome.res
        // Mint deterministic ids for id-less tool calls BEFORE the content
        // fans out into events + persisted messages (durable UI identity).
        const content = withToolCallIds(res.content as ReadonlyArray<unknown>, state.turnIndex)
        const usage = extractUsage(res.usage, content)
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
        yield* Effect.forEach(responseToolResults(content), (tr) =>
          onEvent({
            type: "tool_end",
            turnIndex: state.turnIndex,
            toolCallId: tr.id,
            toolName: tr.toolName,
            args: argsByCallId.get(tr.id) ?? {},
            ok: tr.ok,
            result: tr.result,
          }),
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

        const finalText = text.length > 0 ? text : state.finalText
        const turnIndex = state.turnIndex + 1
        const wantsMore = res.finishReason === "tool-calls" && toolCalls.length > 0
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
        return {
          messages: Option.match(applied, {
            onNone: () => nextMessages,
            onSome: (p) => [handoffToMessage(p.summary), ...nextMessages.slice(p.keepFrom)],
          }),
          newTail: [...state.newTail, ...tail, ...nudge],
          finalText: broke && finalText.length === 0 ? DEGENERATE_LOOP_STOP : finalText,
          turnIndex,
          malformedStreak: 0,
          seen,
          staleTurns: stale,
          usage: addUsage(state.usage, usage),
          phase,
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
    // The run span states its verdict — a one-turn trace that claims
    // "completed" with tool calls pending is visible at a glance.
    yield* Effect.annotateCurrentSpan({
      "engine.outcome": outcome,
      "engine.reason": reason,
      "engine.turns": final.turnIndex,
      "engine.usage.total_tokens": final.usage.totalTokens,
    })
    return {
      finalText: final.finalText,
      messages: final.messages,
      newTail: final.newTail,
      outcome,
      reason,
    } satisfies AgentResult
  }).pipe(Effect.withSpan("engine.run"))
