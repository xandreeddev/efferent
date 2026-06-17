import { Effect, FiberRef, Option } from "effect"
import type { AgentMessage } from "../entities/Conversation.js"
import type { Prompt } from "../entities/Prompt.js"
import type { TokenUsage } from "../ports/LlmInfo.js"
import { UtilityLlm } from "../ports/UtilityLlm.js"
import { planContentCompression, type ContentPlan } from "./headroomContent.js"
import { RunContextRef } from "./runContext.js"

/**
 * **Headroom** — cache-safe context compression, inspired by the tactics in
 * github.com/chopratejas/headroom (a Python proxy we can't depend on; the
 * ideas port cleanly). The constraint that shapes everything here: provider
 * prompt caches key on a **byte-stable prefix**, so compression must never
 * rewrite history. Three tactics follow:
 *
 * 1. **Append-time compression** — oversized tool results are clipped the
 *    moment they enter the message buffer, before the model (or the cache)
 *    ever sees them. The buffer stays append-only; every earlier byte is
 *    untouched; caches keep hitting. (The TUI still shows the full output —
 *    hooks fire from the raw response before the tail is compressed.)
 *    Compression is **structure-aware first** (`headroomContent.ts`):
 *    grep-shaped output is grouped per file, Bash logs keep errors + traces
 *    + summaries; only shapeless text gets the blind head+tail clip.
 * 2. **Reversible markers** — the clip marker tells the model exactly how to
 *    retrieve what was dropped (`read_file` with offset/limit, a narrower
 *    grep, `| head`): compression the model can undo on demand, not a hole.
 * 3. **Fast-tier middle summaries** — when a large middle is dropped and the
 *    `UtilityLlm` service is present, the FAST role writes a ≤120-word digest
 *    into the marker, so the model knows what it isn't seeing. Best-effort:
 *    no service / a provider error degrades to the plain marker.
 *
 * The fourth tactic — folding the whole context at a threshold — lives in the
 * driver (`autoHandoffPct`): a handoff rebuilds the prefix ONCE at a
 * deliberate boundary and is then stable again, which is the only cache-safe
 * way to shrink history. {@link shouldAutoHandoff} is its trigger.
 */

/** ~4 chars/token — the same coarse estimate the resume gauge uses. */
export const estimateTokens = (chars: number): number => Math.round(chars / 4)

/** Default per-string budget for a tool result (~4k tokens). */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 16_000

/** Dropped middles smaller than this aren't worth a fast-model summary. */
const SUMMARY_MIN_DROPPED_CHARS = 4_000

/** Cap on what we FEED the summarizer (a 2M-char log needn't be read whole). */
const SUMMARY_INPUT_MAX_CHARS = 24_000

/** A planned clip: what stays, what goes. `undefined` plan = the text fits. */
export interface ClipPlan {
  readonly head: string
  readonly tail: string
  readonly dropped: string
}

/**
 * Plan a head+tail clip for an oversized string: keep the first ~3/4 and the
 * last ~1/8 of the budget (openings carry structure — headers, signatures,
 * the first error; endings carry conclusions — exit codes, last lines), drop
 * the middle. Pure; the marker is rendered separately so an (async) summary
 * can be woven in.
 */
export const planClip = (text: string, maxChars: number): ClipPlan | undefined => {
  if (maxChars <= 0 || text.length <= maxChars) return undefined
  const headLen = Math.floor(maxChars * 0.75)
  const tailLen = Math.floor(maxChars * 0.125)
  return {
    head: text.slice(0, headLen),
    tail: tailLen > 0 ? text.slice(text.length - tailLen) : "",
    dropped: text.slice(headLen, text.length - tailLen),
  }
}

/** Assemble the clipped text: head + a reversible marker (+ summary) + tail. */
export const renderClip = (plan: ClipPlan, toolName: string, summary?: string): string => {
  const dropped = `~${estimateTokens(plan.dropped.length)} tokens`
  const digest = summary !== undefined && summary.trim().length > 0
    ? ` Summary of the omitted part: ${summary.trim()}`
    : ""
  return (
    `${plan.head}\n` +
    `[…headroom: ${dropped} of this ${toolName} output omitted.${digest}` +
    ` To retrieve it, re-run the tool narrower — read_file with offset/limit,` +
    ` a more specific grep, or bash piped through head/tail.]\n` +
    `${plan.tail}`
  )
}

/** Assemble a structural compression: selection + a reversible marker. */
export const renderContent = (plan: ContentPlan, summary?: string): string => {
  const digest = summary !== undefined && summary.trim().length > 0
    ? ` Summary of the omitted part: ${summary.trim()}`
    : ""
  return (
    `${plan.kept}\n` +
    `[…headroom: ${plan.summary}.${digest} To retrieve, ${plan.hint}.]`
  )
}

/** Default auto-fold threshold (percent of the context window). */
export const DEFAULT_AUTO_HANDOFF_PCT = 85

/** `true` when the context is full enough that the driver should fold now. */
export const shouldAutoHandoff = (
  inputTokens: number,
  contextWindow: number,
  pct: number,
): boolean =>
  pct > 0 && contextWindow > 0 && inputTokens / contextWindow >= pct / 100

const HEADROOM_DIGEST_PROMPT_VERSION = "1.0.0"

const SUMMARIZE_PROMPT =
  "Condense the following omitted middle section of a tool output into at most 120 words. " +
  "Dense and factual: preserve identifiers, file paths, numbers, error messages. " +
  "No preamble — output only the summary."

const headroomDigestPrompt = (): Prompt => ({
  name: "headroom-digest",
  version: HEADROOM_DIGEST_PROMPT_VERSION,
  text: SUMMARIZE_PROMPT,
})

/** What one compression pass did — surfaced so callers can report spend. */
export interface CompressionReport {
  readonly messages: ReadonlyArray<AgentMessage>
  /** FAST-tier usage from middle summaries (absent when none ran). */
  readonly helperUsage?: TokenUsage
}

interface ToolResultPart {
  readonly type: string
  readonly toolName?: string
  output?: unknown
  [k: string]: unknown
}

const sumUsage = (a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined =>
  a === undefined
    ? b
    : b === undefined
      ? a
      : {
          inputTokens: a.inputTokens + b.inputTokens,
          outputTokens: a.outputTokens + b.outputTokens,
          totalTokens: a.totalTokens + b.totalTokens,
          cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        }

/**
 * Compress every oversized string inside the tool-result parts of a step's
 * new tail — append-time, so nothing already in the buffer is ever touched.
 * Walks each result object one level deep (tool outputs are flat Structs:
 * `{ content }`, `{ stdout, stderr }`, `{ diff }`…), clips strings over
 * `maxChars`, and — when `UtilityLlm` is in context and the dropped middle is
 * big enough — folds a FAST-tier digest into the marker. Never fails: a
 * summarizer error degrades to the plain reversible marker.
 */
export const compressToolResults = (
  messages: ReadonlyArray<AgentMessage>,
  maxChars: number,
): Effect.Effect<CompressionReport> =>
  Effect.gen(function* () {
    if (maxChars <= 0) return { messages }
    const utility = yield* Effect.serviceOption(UtilityLlm)
    let helperUsage: TokenUsage | undefined

    const summarize = (dropped: string): Effect.Effect<string | undefined> =>
      Effect.gen(function* () {
        if (Option.isNone(utility) || dropped.length < SUMMARY_MIN_DROPPED_CHARS) {
          return undefined
        }
        const prompt = headroomDigestPrompt()
        const rc = yield* FiberRef.get(RunContextRef)
        return yield* utility.value
          .complete(
            `${prompt.text}\n\n<omitted>\n${dropped.slice(0, SUMMARY_INPUT_MAX_CHARS)}\n</omitted>`,
            { role: "fast" },
          )
          .pipe(
            Effect.locally(RunContextRef, { ...rc, prompt }),
            Effect.map((res) => {
              helperUsage = sumUsage(helperUsage, res.usage)
              return res.text
            }),
            Effect.catchAll(() => Effect.succeed(undefined)),
            Effect.withSpan("agent.headroom.digest"),
          )
      })

    // One string path: try a structure-aware plan first (grep shape from
    // any tool, log shape from Bash — see headroomContent.ts), fall back to
    // the blind head+tail clip. Both end in the same reversible marker; the
    // fast digest runs only where the dropped text carries something a
    // digest can say (logs and blind middles — not omitted grep matches).
    const compressString = (text: string, toolName: string): Effect.Effect<string> =>
      Effect.gen(function* () {
        if (text.length <= maxChars) return text
        const content = planContentCompression(text, toolName, maxChars)
        if (content !== undefined) {
          const summary = content.omitted.length > 0
            ? yield* summarize(content.omitted)
            : undefined
          return renderContent(content, summary)
        }
        const plan = planClip(text, maxChars)
        if (plan === undefined) return text
        const summary = yield* summarize(plan.dropped)
        return renderClip(plan, toolName, summary)
      })

    const compressValue = (value: unknown, toolName: string): Effect.Effect<unknown> =>
      Effect.gen(function* () {
        if (typeof value === "string") {
          return yield* compressString(value, toolName)
        }
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const obj = value as Record<string, unknown>
          const out: Record<string, unknown> = { ...obj }
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === "string" && v.length > maxChars) {
              out[k] = yield* compressString(v, toolName)
            }
          }
          return out
        }
        return value
      })

    const out: AgentMessage[] = []
    for (const msg of messages) {
      if (msg.role !== "tool" || typeof msg.content === "string") {
        out.push(msg)
        continue
      }
      const parts: unknown[] = []
      for (const raw of msg.content as ReadonlyArray<unknown>) {
        const p = raw as ToolResultPart
        if (p?.type !== "tool-result") {
          parts.push(raw)
          continue
        }
        const output = yield* compressValue(p.output, p.toolName ?? "tool")
        parts.push(output === p.output ? p : { ...p, output })
      }
      out.push({ ...msg, content: parts } as unknown as AgentMessage)
    }
    return { messages: out, ...(helperUsage !== undefined ? { helperUsage } : {}) }
  })
