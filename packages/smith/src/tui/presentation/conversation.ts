import { Array as Arr, Match, Option } from "effect"
import type { FactoryRun } from "@xandreed/foundry"
import type { SmithEvent } from "../../domain/SmithEvent.js"
import { capabilitiesPhrase } from "../../presentation/eventLines.js"

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
      /** A LIVE block still growing from assistant_delta events — replaced
       *  wholesale when the turn's assistant_message finalizes (replay ≡
       *  live: a :resume rebuild produces only settled blocks). */
      readonly streaming?: boolean
      /** The delta turn this live block belongs to (upsert key). */
      readonly turn?: number
    }
  | {
      readonly kind: "assistant"
      readonly text: string
      readonly tag: string
      /** True when this block STARTS its turn (no reasoning before it) —
       *  it then owns the blank line and the "└ tag" meta line. */
      readonly leading: boolean
      readonly tokens: { readonly input: number; readonly output: number; readonly cached: number }
      readonly streaming?: boolean
      readonly turn?: number
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
      /** The tool's (clipped) result once it landed — ctrl+o expands the
       *  newest one in-pane. */
      readonly result?: string
      /** The latest live output line while the command RUNS (bash tap). */
      readonly note?: string
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
const TOOL_RESULT_BUDGET = 8_000

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

/** A tool result, human-readable: strings verbatim, objects one-per-line. */
const stringifyResult = (result: unknown): string =>
  typeof result === "string" ? result : JSON.stringify(result ?? null, null, 1)

const push = (
  state: ConversationState,
  ...blocks: ReadonlyArray<ConversationBlock>
): ConversationState => ({ blocks: [...state.blocks, ...blocks].slice(-BLOCKS_CAP) })

const isStreamingBlock = (
  block: ConversationBlock,
): block is Extract<ConversationBlock, { kind: "reasoning" | "assistant" }> =>
  (block.kind === "reasoning" || block.kind === "assistant") && block.streaming === true

/** Drop the live blocks — the finalizer restates their content settled. */
const withoutStreaming = (state: ConversationState): ConversationState => ({
  blocks: state.blocks.filter((block) => !isStreamingBlock(block)),
})

/** An orphaned live block (its turn never finalized — a mid-stream failure
 *  or an interrupt) SEALS in place: the partial stays visible as story. */
const sealStreaming = (state: ConversationState): ConversationState => ({
  blocks: state.blocks.map((block) =>
    isStreamingBlock(block) ? { ...block, streaming: false } : block,
  ),
})

/** One growing block per (turn, channel): append in place, else open. */
const upsertDelta = (
  state: ConversationState,
  delta: {
    readonly turnIndex: number
    readonly channel: "text" | "reasoning"
    readonly delta: string
  },
): ConversationState => {
  const kind = delta.channel === "reasoning" ? ("reasoning" as const) : ("assistant" as const)
  const grown = state.blocks.reduce(
    (acc: { readonly found: boolean; readonly blocks: ReadonlyArray<ConversationBlock> }, block) =>
      !acc.found && isStreamingBlock(block) && block.kind === kind && block.turn === delta.turnIndex
        ? {
            found: true,
            blocks: [
              ...acc.blocks,
              {
                ...block,
                text:
                  kind === "reasoning"
                    ? clip(block.text + delta.delta, REASONING_BUDGET)
                    : block.text + delta.delta,
              },
            ],
          }
        : { found: acc.found, blocks: [...acc.blocks, block] },
    { found: false, blocks: [] },
  )
  if (grown.found) return { blocks: grown.blocks }
  const zero = { input: 0, output: 0, cached: 0 }
  const hasReasoning = state.blocks.some(
    (block) => isStreamingBlock(block) && block.kind === "reasoning" && block.turn === delta.turnIndex,
  )
  return push(
    state,
    kind === "reasoning"
      ? {
          kind: "reasoning",
          text: clip(delta.delta, REASONING_BUDGET),
          tag: "thinking…",
          tokens: zero,
          streaming: true,
          turn: delta.turnIndex,
        }
      : {
          kind: "assistant",
          text: delta.delta,
          tag: "streaming…",
          leading: !hasReasoning,
          tokens: zero,
          streaming: true,
          turn: delta.turnIndex,
        },
  )
}

/** The driver adds the human's line directly (it is not an agent event). */
export const withUserBlock = (state: ConversationState, text: string): ConversationState =>
  push(state, { kind: "user", text })

/** A bounded stop means DIFFERENT things per mode: in refine the HUMAN
 *  continues the session; in forge the LOOP continues itself (snapshot →
 *  gates → feedback → next attempt) — advising "send a message" there
 *  misled a live run into looking stuck. */
const partialNotice = (mode: "profile" | "refine" | "forge", reason: string): string =>
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
  mode: "profile" | "refine" | "forge",
) => (
  state: ConversationState,
  event: SmithEvent,
): ConversationState =>
  Match.value(event).pipe(
    Match.when({ type: "agent" }, (e) =>
      Match.value(e.event).pipe(
        // A new turn seals any orphaned live blocks from the previous one
        // (a mid-stream malformed keeps its partial as story).
        Match.when({ type: "turn_start" }, () => sealStreaming(state)),
        // tool-params deltas are streamed tool ARGUMENTS (incremental
        // admission plumbing) — raw JSON, never conversation copy.
        Match.when({ type: "assistant_delta" }, (d) =>
          d.channel === "tool-params" ? state : upsertDelta(state, { ...d, channel: d.channel })),
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
              ? {
                  ...block,
                  status: t.ok ? ("ok" as const) : ("fail" as const),
                  result: clip(stringifyResult(t.result), TOOL_RESULT_BUDGET),
                }
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
          // The FINALIZER: the live blocks vanish and the settled ones land
          // through the same shape a :resume replay produces (replay ≡ live).
          // ONE meta line per turn: on the "▸" header when the model thought,
          // on a "└" line otherwise — and every turn lands SOMETHING (a
          // tool-only turn still shows its spend).
          return push(
            withoutStreaming(state),
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
            ? sealStreaming(state)
            : push(sealStreaming(state), { kind: "notice", text: partialNotice(mode, end.reason) }),
        ),
        Match.when({ type: "error" }, () => sealStreaming(state)),
        Match.orElse(() => state),
      ),
    ),
    Match.when({ type: "refine_error" }, (e) =>
      push(sealStreaming(state), { kind: "error", text: clip(e.message, REASONING_BUDGET) }),
    ),
    Match.when({ type: "profile_error" }, (e) =>
      push(sealStreaming(state), { kind: "error", text: clip(e.message, REASONING_BUDGET) }),
    ),
    Match.when({ type: "profile_draft" }, (e) =>
      push(state, {
        kind: "notice",
        text: `profile draft: ${e.rules.length} rules · ${e.boundaryViolations} boundary findings · ${e.checks.length} checks — review, revise, then :lock`,
      }),
    ),
    Match.when({ type: "profile_locked" }, (e) =>
      push(state, {
        kind: "result",
        ok: true,
        text: `profile locked: ${e.rules} rules · ${e.grandfathered} grandfathered · ${e.checks} checks → ${e.configPath}`,
        artifact: e.configPath,
      }),
    ),
    Match.when({ type: "bash_progress" }, (e) => {
      // The newest RUNNING tool block wears the live line; nothing running
      // (a race at command end) drops it silently.
      const at = state.blocks.reduce<number>(
        (found, block, index) =>
          block.kind === "tool" && block.status === "running" ? index : found,
        -1,
      )
      return at < 0
        ? state
        : {
            blocks: state.blocks.map((block, index) =>
              index === at && block.kind === "tool" ? { ...block, note: e.line } : block,
            ),
          }
    }),
    Match.when({ type: "file_refs" }, (e) =>
      push(state, { kind: "notice", text: `file refs: ${e.notes.join(" · ")}` }),
    ),
    Match.when({ type: "vacuous_checks" }, (e) =>
      push(state, {
        kind: "notice",
        text: `red-first: ${e.names.join(", ")} already PASS on the untouched workspace — these checks cannot measure this spec's work; tighten the spec or expect a vacuous accept`,
      }),
    ),
    Match.when({ type: "missing_tools" }, (e) =>
      push(state, {
        kind: "notice",
        text: `environment: ${e.names.join(", ")} cannot run — their tool is MISSING from PATH; the coder must provision it into .local/bin, or Esc and install it on the host`,
      }),
    ),
    Match.when({ type: "profile_status" }, (e) =>
      push(state, {
        kind: "notice",
        text: e.armed
          ? `quality profile: ${e.rules} rule(s) armed · ${e.baseline} grandfathered`
          : "quality profile: NONE — generic gates only (typecheck + tests); run `bun run smith profile` to arm one",
      }),
    ),
    Match.when({ type: "capabilities" }, (e) =>
      push(state, {
        kind: "notice",
        text: `harness: ${capabilitiesPhrase(e)} loaded for this run`,
      }),
    ),
    Match.when({ type: "context_folded" }, (e) =>
      push(state, {
        kind: "notice",
        text: `context folded at ${fmtTokens(e.tokens)} tokens — attempt ${e.attempt} resumes from a handoff summary + the gate brief`,
      }),
    ),
    Match.when({ type: "memory_updated" }, (e) =>
      push(state, {
        kind: "notice",
        text: `workspace memory curated — ${e.created} new · ${e.corroborated} corroborated · ${e.updated} updated · ${e.invalidated} invalidated (.efferent/memory/ledger.jsonl)`,
      }),
    ),
    Match.when({ type: "skills_distilled" }, (e) =>
      push(state, {
        kind: "notice",
        text: `distilled ${e.names.length} skill${e.names.length === 1 ? "" : "s"} from corroborated memory: ${e.names.join(", ")}`,
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
 *  everything the model was just sent. None until a turn completes. A live
 *  (streaming) block carries no usage yet and must not zero the gauge. */
export const contextTokens = (state: ConversationState): Option.Option<number> =>
  Option.fromNullable(
    state.blocks.reduce<number | undefined>(
      (latest, block) =>
        (block.kind === "assistant" || block.kind === "reasoning") &&
        block.streaming !== true
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

/**
 * FOLDS: with folds on, a COMPLETED tool group (consecutive tool blocks,
 * none still running) collapses to its opener — one line naming the count
 * and the distinct tools. `None` = render this block normally; `Some("")`
 * = skip (a folded group member); `Some(line)` = the fold line.
 */
export const foldedToolLine = (
  blocks: ReadonlyArray<ConversationBlock>,
  index: number,
): Option.Option<string> => {
  const block = blocks[index]
  if (block === undefined || block.kind !== "tool") return Option.none()
  // The group starts at the nearest opener at-or-before this block.
  const start = blocks.reduce<number>(
    (found, b, i) => (i <= index && b.kind === "tool" && b.first ? i : found),
    index,
  )
  // …and runs while consecutive non-opener tool blocks follow.
  const runLength = blocks
    .slice(start)
    .findIndex((b, i) => i > 0 && (b.kind !== "tool" || b.first))
  const size = runLength === -1 ? blocks.length - start : runLength
  const members = blocks.slice(start, start + size) as ReadonlyArray<
    Extract<ConversationBlock, { kind: "tool" }>
  >
  // Running groups and singletons stay expanded — the fold is for FINISHED
  // exploration noise, never for what is happening right now.
  if (members.some((m) => m.status === "running")) return Option.none()
  if (size < 2) return Option.none()
  if (index !== start) return Option.some("")
  const distinct = [...new Set(members.map((m) => m.name))]
  return Option.some(
    `${size} tool calls · ${distinct.slice(0, 4).join(", ")}${distinct.length > 4 ? ", …" : ""}`,
  )
}
