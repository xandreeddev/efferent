import { Array as Arr, Match, Option } from "effect"
import type { FactoryRun } from "@xandreed/foundry"
import type { SmithEvent } from "../../domain/SmithEvent.js"

/**
 * The conversation pane's fold — the FULL story of a session as ordered
 * blocks: what you said, what the model THOUGHT (reasoning, first-class,
 * not hidden), what it said (with the model that said it), and every tool
 * call with its live status. Both modes feed it: the refiner's turns and
 * the forge implementor's run render through the same fold.
 */

export type ConversationBlock =
  | { readonly kind: "user"; readonly text: string }
  /** The turn HEADER when the model thought: "▸ model · Nk in · N out" over
   *  the reasoning text (the agy pattern — meta rides the thought line). */
  | {
      readonly kind: "reasoning"
      readonly text: string
      readonly tag: string
      readonly tokens: { readonly input: number; readonly output: number; readonly cached: number }
    }
  | {
      readonly kind: "assistant"
      readonly text: string
      readonly tag: string
      /** True when this block STARTS its turn (no reasoning before it) —
       *  it then owns the blank line and the "└ tag" meta line. */
      readonly leading: boolean
      readonly tokens: { readonly input: number; readonly output: number; readonly cached: number }
    }
  | {
      readonly kind: "tool"
      readonly id: string
      readonly name: string
      readonly arg: string
      readonly status: "running" | "ok" | "fail"
      /** True when this call OPENS its tool group (the previous block is
       *  not a tool) — the renderer puts the breathing line here. */
      readonly first: boolean
    }
  /** A turn that DIED — durable in the story, unlike the transient notice. */
  | { readonly kind: "error"; readonly text: string }
  /** A BOUNDED stop (step cap, loop breaker) — not a failure, but it must
   *  never be silent: an invisible partial outcome reads as a hang
   *  (live-caught: 16 exploration steps, then nothing). */
  | { readonly kind: "notice"; readonly text: string }
  /** The run's VERDICT — the loudest block in the story. A user watched a
   *  run get ACCEPTED and concluded it died: the flow stepper's result row
   *  alone was not loud enough. The verdict lands IN the conversation, as
   *  durable as the ⚠ notices. */
  | {
      readonly kind: "result"
      readonly ok: boolean
      readonly text: string
      readonly artifact: string
    }

export interface ConversationState {
  readonly blocks: ReadonlyArray<ConversationBlock>
}

export const initialConversation: ConversationState = { blocks: [] }

const BLOCKS_CAP = 400
const ARG_BUDGET = 72
const REASONING_BUDGET = 500

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

/** The one argument worth showing for a tool call. */
const describeArg = (args: unknown): string => {
  if (typeof args !== "object" || args === null) return ""
  const record = args as Record<string, unknown>
  const key = ["path", "command", "pattern", "name", "query", "slug"].find(
    (k) => typeof record[k] === "string" && (record[k] as string).length > 0,
  )
  return key === undefined ? "" : clip(String(record[key]), ARG_BUDGET)
}

const push = (
  state: ConversationState,
  ...blocks: ReadonlyArray<ConversationBlock>
): ConversationState => ({ blocks: [...state.blocks, ...blocks].slice(-BLOCKS_CAP) })

/** The driver adds the human's line directly (it is not an agent event). */
export const withUserBlock = (state: ConversationState, text: string): ConversationState =>
  push(state, { kind: "user", text })

/** A bounded stop means DIFFERENT things per mode: in refine the HUMAN
 *  continues the session; in forge the LOOP continues itself (snapshot →
 *  gates → feedback → next attempt) — advising "send a message" there
 *  misled a live run into looking stuck. */
const partialNotice = (mode: "refine" | "forge", reason: string): string =>
  mode === "forge"
    ? reason === "step-cap"
      ? "the attempt hit its step ceiling — the snapshot goes to the gates; their findings brief the next attempt automatically"
      : "the attempt stalled repeating the same tool call — the gates judge what landed; their findings brief the next attempt"
    : reason === "step-cap"
      ? 'stopped at the per-message step ceiling before finishing — the session is SAVED; send another message (e.g. "continue") to keep going'
      : "stopped after repeating the same tool call with no progress — the session is saved; rephrase or narrow the ask"

const attempts = (n: number): string => `${n} attempt${n === 1 ? "" : "s"}`

/** `forge_end` → the verdict block. The finding count is the FINAL attempt's
 *  still-failing findings (what stands between the work and acceptance), not
 *  the sum over retries. */
const resultBlock = (run: FactoryRun, artifact: string): ConversationBlock =>
  Match.value(run.outcome).pipe(
    Match.tag("accepted", () => ({
      kind: "result" as const,
      ok: true,
      text: `ACCEPTED after ${attempts(run.attempts.length)}`,
      artifact,
    })),
    Match.tag("rejected", (outcome) => {
      const failing = Arr.lastNonEmpty(run.attempts).report.failures.flatMap(
        (failure) => failure.findings,
      ).length
      return {
        kind: "result" as const,
        ok: false,
        text: `REJECTED (${outcome.reason}) after ${attempts(run.attempts.length)} · ${failing} finding${failing === 1 ? "" : "s"} still failing`,
        artifact,
      }
    }),
    // forge_end never carries the mid-run upsert marker; type-complete anyway.
    Match.tag("in-flight", () => ({
      kind: "result" as const,
      ok: false,
      text: `still in flight after ${attempts(run.attempts.length)}`,
      artifact,
    })),
    Match.exhaustive,
  )

/** The fold, mode-curried. `reduceConversation` below stays the refine-worded
 *  binding — safe as a bare Array.reduce callback, where a positional mode
 *  parameter would collide with reduce's index argument. */
export const reduceConversationIn = (
  mode: "refine" | "forge",
) => (
  state: ConversationState,
  event: SmithEvent,
): ConversationState =>
  Match.value(event).pipe(
    Match.when({ type: "agent" }, (e) =>
      Match.value(e.event).pipe(
        Match.when({ type: "tool_start" }, (t) =>
          push(state, {
            kind: "tool",
            id: t.toolCallId,
            name: t.toolName,
            arg: describeArg(t.args),
            status: "running",
            first: state.blocks[state.blocks.length - 1]?.kind !== "tool",
          }),
        ),
        Match.when({ type: "tool_end" }, (t) => ({
          blocks: state.blocks.map((block) =>
            block.kind === "tool" && block.id === t.toolCallId
              ? { ...block, status: t.ok ? ("ok" as const) : ("fail" as const) }
              : block,
          ),
        })),
        Match.when({ type: "assistant_message" }, (m) => {
          const reasoning = m.reasoning.trim()
          const text = m.text.trim()
          const tokens = {
            input: m.usage.inputTokens,
            output: m.usage.outputTokens,
            cached: m.usage.cacheReadTokens,
          }
          // "turn" labels WHOSE tokens these are — one model call, not the
          // session (the session-level number is the ctx gauge). The cached
          // share shows what the prefix cache absorbed of the input.
          const tag = [
            ...Option.match(Option.fromNullable(m.model), { onNone: () => [], onSome: (id) => [id] }),
            `turn ${fmtTokens(tokens.input)} in${
              tokens.cached > 0 ? ` (${fmtTokens(tokens.cached)} cached)` : ""
            } · ${fmtTokens(tokens.output)} out`,
          ].join(" · ")
          const hasReasoning = reasoning.length > 0
          // ONE meta line per turn: on the "▸" header when the model thought,
          // on a "└" line otherwise — and every turn lands SOMETHING (a
          // tool-only turn still shows its spend).
          return push(
            state,
            ...(hasReasoning
              ? [{ kind: "reasoning", text: clip(reasoning, REASONING_BUDGET), tag, tokens } as const]
              : []),
            ...(text.length > 0 || !hasReasoning
              ? [{ kind: "assistant", text, tag, leading: !hasReasoning, tokens } as const]
              : []),
          )
        }),
        Match.when({ type: "agent_end" }, (end) =>
          end.outcome === "ok"
            ? state
            : push(state, { kind: "notice", text: partialNotice(mode, end.reason) }),
        ),
        Match.orElse(() => state),
      ),
    ),
    Match.when({ type: "refine_error" }, (e) =>
      push(state, { kind: "error", text: clip(e.message, REASONING_BUDGET) }),
    ),
    Match.when({ type: "vacuous_checks" }, (e) =>
      push(state, {
        kind: "notice",
        text: `red-first: ${e.names.join(", ")} already PASS on the untouched workspace — these checks cannot measure this spec's work; tighten the spec or expect a vacuous accept`,
      }),
    ),
    Match.when({ type: "context_folded" }, (e) =>
      push(state, {
        kind: "notice",
        text: `context folded at ${fmtTokens(e.tokens)} tokens — attempt ${e.attempt} resumes from a handoff summary + the gate brief`,
      }),
    ),
    // Ship steps ride the TOOL block shape — the ● color language (green ok /
    // red failed) reads exactly right for a git sequence.
    Match.when({ type: "ship_step" }, (e) =>
      push(state, {
        kind: "tool",
        id: `ship-${e.step}`,
        name: `ship ${e.step}`,
        arg: clip(e.detail, ARG_BUDGET),
        status: e.ok ? "ok" : "fail",
        first: state.blocks[state.blocks.length - 1]?.kind !== "tool",
      }),
    ),
    Match.when({ type: "forge_end" }, (e) => push(state, resultBlock(e.run, e.artifact))),
    Match.when({ type: "forge_error" }, (e) =>
      push(state, { kind: "error", text: clip(`forge failed: ${e.message}`, REASONING_BUDGET) }),
    ),
    Match.orElse(() => state),
  )

/** The refine-worded binding (the Array.reduce-safe default). */
export const reduceConversation = reduceConversationIn("refine")

/** "1.2k" past a thousand ("256k" when round) — scannable at any size. */
export const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n)

/** The LIVE context cost: the latest turn's input tokens ARE the context —
 *  everything the model was just sent. None until a turn completes. */
export const contextTokens = (state: ConversationState): Option.Option<number> =>
  Option.fromNullable(
    state.blocks.reduce<number | undefined>(
      (latest, block) =>
        block.kind === "assistant" || block.kind === "reasoning"
          ? block.tokens.input
          : latest,
      undefined,
    ),
  )

/** "ctx 17.9k/256k (7%)" — the gauge the status strip renders; absolute-only
 *  when the model's window is unknown. */
export const contextGauge = (
  used: Option.Option<number>,
  window: Option.Option<number>,
): Option.Option<string> =>
  Option.map(used, (tokens) =>
    Option.match(window, {
      onNone: () => `ctx ${fmtTokens(tokens)}`,
      onSome: (max) =>
        `ctx ${fmtTokens(tokens)}/${fmtTokens(max)} (${Math.round((tokens / max) * 100)}%)`,
    }),
  )
