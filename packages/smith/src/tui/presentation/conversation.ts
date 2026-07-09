import { Match, Option } from "effect"
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
      readonly tokens: { readonly input: number; readonly output: number }
    }
  | {
      readonly kind: "assistant"
      readonly text: string
      readonly tag: string
      /** True when this block STARTS its turn (no reasoning before it) —
       *  it then owns the blank line and the "└ tag" meta line. */
      readonly leading: boolean
      readonly tokens: { readonly input: number; readonly output: number }
    }
  | {
      readonly kind: "tool"
      readonly id: string
      readonly name: string
      readonly arg: string
      readonly status: "running" | "ok" | "fail"
    }
  /** A turn that DIED — durable in the story, unlike the transient notice. */
  | { readonly kind: "error"; readonly text: string }
  /** A BOUNDED stop (step cap, loop breaker) — not a failure, but it must
   *  never be silent: an invisible partial outcome reads as a hang
   *  (live-caught: 16 exploration steps, then nothing). */
  | { readonly kind: "notice"; readonly text: string }

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

export const reduceConversation = (
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
          const tokens = { input: m.usage.inputTokens, output: m.usage.outputTokens }
          // "turn" labels WHOSE tokens these are — one model call, not the
          // session (the session-level number is the ctx gauge).
          const tag = [
            ...Option.match(Option.fromNullable(m.model), { onNone: () => [], onSome: (id) => [id] }),
            `turn ${fmtTokens(tokens.input)} in · ${fmtTokens(tokens.output)} out`,
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
            : push(state, {
                kind: "notice",
                text:
                  end.reason === "step-cap"
                    ? 'stopped at the per-message step ceiling before finishing — the session is SAVED; send another message (e.g. "continue") to keep going'
                    : "stopped after repeating the same tool call with no progress — the session is saved; rephrase or narrow the ask",
              }),
        ),
        Match.orElse(() => state),
      ),
    ),
    Match.when({ type: "refine_error" }, (e) =>
      push(state, { kind: "error", text: clip(e.message, REASONING_BUDGET) }),
    ),
    Match.orElse(() => state),
  )

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
