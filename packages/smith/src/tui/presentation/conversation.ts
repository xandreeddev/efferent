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
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "assistant"
      readonly text: string
      readonly model: Option.Option<string>
      /** This turn's spend — rendered on the tag line ("1.2k in · 63 out"). */
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
          // EVERY turn lands a block — a tool-only turn still shows its
          // model + spend as a tag line above its tool calls.
          return push(
            state,
            ...(reasoning.length > 0
              ? [{ kind: "reasoning", text: clip(reasoning, REASONING_BUDGET) } as const]
              : []),
            {
              kind: "assistant",
              text,
              model: Option.fromNullable(m.model),
              tokens: { input: m.usage.inputTokens, output: m.usage.outputTokens },
            } as const,
          )
        }),
        Match.orElse(() => state),
      ),
    ),
    Match.when({ type: "refine_error" }, (e) =>
      push(state, { kind: "error", text: clip(e.message, REASONING_BUDGET) }),
    ),
    Match.orElse(() => state),
  )

/** "1.2k" past a thousand — token counts stay scannable at any size. */
export const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
