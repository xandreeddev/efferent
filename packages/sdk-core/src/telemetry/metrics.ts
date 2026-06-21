import { Effect, Metric, MetricBoundaries } from "effect"
import { costUsd } from "../entities/Model.js"
import type { TokenUsage } from "../ports/LlmInfo.js"

/**
 * The agent's metric set — pure `effect` `Metric`s, recorded at the chokepoints
 * (router, agent loop, helpers). They're inert until a meter is wired up by a
 * telemetry layer at the edge (`OtlpTelemetryLive` in adapters, or the eval
 * collector), so production code only ever *records*; where the numbers go is a
 * layer choice. Tags keep cardinality bounded (role / provider / model / tool /
 * verdict — never per-request ids).
 */

/**
 * The metric names, in one place — so the recorder (below) and any in-process
 * reader (the daemon's `readWorkspaceMetrics`, which folds `Metric.snapshot` by
 * name + tags into the live dashboard) can't drift apart.
 */
export const METRIC_NAMES = {
  tokens: "gen_ai_tokens_total",
  calls: "gen_ai_calls_total",
  cost: "gen_ai_cost_usd_total",
  errors: "agent_errors_total",
  turns: "agent_turns_total",
  turnLatency: "agent_turn_latency_ms",
  toolCalls: "agent_tool_calls_total",
  approvalVerdicts: "approval_verdicts_total",
} as const

const tokensTotal = Metric.counter(METRIC_NAMES.tokens, {
  description: "LLM tokens billed (tags: role, model, type=input|output|cache).",
  incremental: true,
})

const callsTotal = Metric.counter(METRIC_NAMES.calls, {
  description: "LLM generate calls (tags: role, provider, model).",
  incremental: true,
})

const costUsdTotal = Metric.counter(METRIC_NAMES.cost, {
  description: "Estimated LLM spend in USD (tags: role, provider, model).",
  incremental: true,
  bigint: false,
})

const errorsTotal = Metric.counter(METRIC_NAMES.errors, {
  description: "Agent failures (tags: kind=turn|tool|llm, error).",
  incremental: true,
})

const turnsTotal = Metric.counter(METRIC_NAMES.turns, {
  description: "Agent-loop turns executed.",
  incremental: true,
})

const turnLatencyMs = Metric.histogram(
  METRIC_NAMES.turnLatency,
  MetricBoundaries.exponential({ start: 50, factor: 2, count: 12 }),
  "Agent-loop turn wall time (ms).",
)

const toolCallsTotal = Metric.counter(METRIC_NAMES.toolCalls, {
  description: "Tool calls resolved (tags: tool, ok).",
  incremental: true,
})

const approvalVerdictsTotal = Metric.counter(METRIC_NAMES.approvalVerdicts, {
  description: "Auto-approval judge verdicts (tags: verdict).",
  incremental: true,
})

/** Span attributes for a token usage (OTel GenAI semantic convention). */
export const usageAttributes = (usage: TokenUsage): Record<string, number> => ({
  "gen_ai.usage.input_tokens": usage.inputTokens,
  "gen_ai.usage.output_tokens": usage.outputTokens,
  "gen_ai.usage.cache_read_tokens": usage.cacheReadTokens,
  "gen_ai.usage.total_tokens": usage.totalTokens,
})

/**
 * Span attributes a human reads at a glance on `llm.generate`: the priced cost
 * (when the model is in the catalogue) and the share of input served from the
 * provider cache. Both are derived from the same usage that feeds the metrics —
 * `cost` is absent when the model carries no pricing (never a wrong number).
 */
export const costAttribute = (
  provider: string,
  model: string,
  usage: TokenUsage,
): Record<string, number> => {
  const cost = costUsd(`${provider}:${model}`, usage)
  const cacheHitRatio =
    usage.inputTokens > 0 ? Math.min(usage.cacheReadTokens, usage.inputTokens) / usage.inputTokens : 0
  return {
    "gen_ai.cache_hit_ratio": cacheHitRatio,
    ...(cost !== undefined ? { "gen_ai.cost_usd": cost } : {}),
  }
}

/** Max chars kept per captured prompt/completion span attribute. */
export const GEN_AI_CONTENT_CAP = 12_000

/** Clip keeping the head and the tail — a prompt's system block + latest message
 *  are the useful ends; the grown middle is what's elided. */
const clipEnds = (s: string, max: number): string => {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.7)
  const tail = max - head - 32
  return `${s.slice(0, head)}\n…[${s.length - head - tail} chars elided]…\n${s.slice(s.length - tail)}`
}

/**
 * Opt-in span attributes carrying an LLM call's prompt + completion text
 * (`Settings.telemetryCaptureContent`). Each is clipped to {@link
 * GEN_AI_CONTENT_CAP}; an empty side is omitted. Names follow the GenAI
 * convention so the trace viewer shows them inline.
 */
export const genAiContentAttributes = (
  prompt: string,
  completion: string,
): Record<string, string> => ({
  ...(prompt.length > 0 ? { "gen_ai.prompt": clipEnds(prompt, GEN_AI_CONTENT_CAP) } : {}),
  ...(completion.length > 0
    ? { "gen_ai.completion": clipEnds(completion, GEN_AI_CONTENT_CAP) }
    : {}),
})

/**
 * Record one LLM call's spend: a call + its three token buckets + the priced
 * USD cost (when the model is in the pricing catalogue), all tagged by
 * role/provider/model. Cost reuses the same `costUsd` the evals trace-report
 * uses, so a session and an eval price identically.
 */
export const recordLlmCall = (
  role: string,
  provider: string,
  model: string,
  usage: TokenUsage,
): Effect.Effect<void> => {
  const cost = costUsd(`${provider}:${model}`, usage)
  return Effect.all(
    [
      Metric.update(
        callsTotal.pipe(
          Metric.tagged("role", role),
          Metric.tagged("provider", provider),
          Metric.tagged("model", model),
        ),
        1,
      ),
      Metric.update(
        tokensTotal.pipe(
          Metric.tagged("role", role),
          Metric.tagged("model", model),
          Metric.tagged("type", "input"),
        ),
        usage.inputTokens,
      ),
      Metric.update(
        tokensTotal.pipe(
          Metric.tagged("role", role),
          Metric.tagged("model", model),
          Metric.tagged("type", "output"),
        ),
        usage.outputTokens,
      ),
      Metric.update(
        tokensTotal.pipe(
          Metric.tagged("role", role),
          Metric.tagged("model", model),
          Metric.tagged("type", "cache"),
        ),
        usage.cacheReadTokens,
      ),
      ...(cost !== undefined
        ? [
            Metric.update(
              costUsdTotal.pipe(
                Metric.tagged("role", role),
                Metric.tagged("provider", provider),
                Metric.tagged("model", model),
              ),
              cost,
            ),
          ]
        : []),
    ],
    { discard: true },
  )
}

/** Record one agent-loop turn: a tick + its latency. */
export const recordTurn = (latencyMs: number): Effect.Effect<void> =>
  Effect.all([Metric.update(turnsTotal, 1), Metric.update(turnLatencyMs, latencyMs)], {
    discard: true,
  })

/** Record one resolved tool call. */
export const recordToolCall = (tool: string, ok: boolean): Effect.Effect<void> =>
  Metric.update(
    toolCallsTotal.pipe(Metric.tagged("tool", tool), Metric.tagged("ok", ok ? "true" : "false")),
    1,
  )

/** Record one auto-approval verdict. */
export const recordApprovalVerdict = (verdict: string): Effect.Effect<void> =>
  Metric.update(approvalVerdictsTotal.pipe(Metric.tagged("verdict", verdict)), 1)

/**
 * A small bounded set of error labels — the typed-error `_tag` or a short slug,
 * never a raw provider message — so the `error` tag stays low-cardinality. An
 * over-long or unknown value collapses to `"unknown"`.
 */
const clipErr = (error: string): string => {
  const e = error.trim()
  if (e.length === 0) return "unknown"
  // A `_tag` / slug is a short identifier; anything wordy is a free-text
  // message we must NOT use as a metric label (cardinality bomb).
  if (e.length > 48 || /\s/.test(e)) return "unknown"
  return e
}

/** Record one agent failure, tagged by where it happened + a bounded label. */
export const recordError = (kind: string, error: string): Effect.Effect<void> =>
  Metric.update(
    errorsTotal.pipe(Metric.tagged("kind", kind), Metric.tagged("error", clipErr(error))),
    1,
  )
