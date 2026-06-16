import { Effect, Metric, MetricBoundaries } from "effect"
import type { TokenUsage } from "../ports/LlmInfo.js"

/**
 * The agent's metric set — pure `effect` `Metric`s, recorded at the chokepoints
 * (router, agent loop, helpers). They're inert until a meter is wired up by a
 * telemetry layer at the edge (`OtlpTelemetryLive` in adapters, or the eval
 * collector), so production code only ever *records*; where the numbers go is a
 * layer choice. Tags keep cardinality bounded (role / provider / model / tool /
 * verdict — never per-request ids).
 */

const tokensTotal = Metric.counter("gen_ai_tokens_total", {
  description: "LLM tokens billed (tags: role, model, type=input|output|cache).",
  incremental: true,
})

const callsTotal = Metric.counter("gen_ai_calls_total", {
  description: "LLM generate calls (tags: role, provider, model).",
  incremental: true,
})

const turnsTotal = Metric.counter("agent_turns_total", {
  description: "Agent-loop turns executed.",
  incremental: true,
})

const turnLatencyMs = Metric.histogram(
  "agent_turn_latency_ms",
  MetricBoundaries.exponential({ start: 50, factor: 2, count: 12 }),
  "Agent-loop turn wall time (ms).",
)

const toolCallsTotal = Metric.counter("agent_tool_calls_total", {
  description: "Tool calls resolved (tags: tool, ok).",
  incremental: true,
})

const approvalVerdictsTotal = Metric.counter("approval_verdicts_total", {
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

/** Record one LLM call's spend: a call + its three token buckets, all tagged. */
export const recordLlmCall = (
  role: string,
  provider: string,
  model: string,
  usage: TokenUsage,
): Effect.Effect<void> =>
  Effect.all(
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
    ],
    { discard: true },
  )

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
