import { Effect, Metric } from "effect"
import { METRIC_NAMES, type WorkspaceMetrics } from "@xandreed/sdk-core"
import type { AgentBus } from "../usecases/agentBus.js"

/**
 * Self-contained in-daemon metrics — read the **process-global** Effect metric
 * registry (`Metric.snapshot`, populated by every `Metric.update` regardless of
 * whether OTLP export is on) and the bus, so the control dashboard shows live
 * counters with no Grafana. Global RED + token/cost come from the snapshot
 * (tags are cardinality-bounded — role/model/type/verdict, never per-fleet);
 * running/done agent counts + messages-per-minute come from the bus.
 *
 * Counters are cumulative-since-daemon-start (Effect counters don't reset);
 * `messagesPerMin` is a 60s window over the blackboard.
 */

// A MetricPair is untyped at the snapshot edge; counters carry a numeric
// `count` on their state. Read it defensively (non-counters → 0, ignored).
const pairCount = (pair: { readonly metricState: unknown }): number => {
  const s = pair.metricState as { readonly count?: unknown }
  return typeof s.count === "number" ? s.count : 0
}
const tagOf = (
  pair: { readonly metricKey: { readonly tags: ReadonlyArray<{ key: string; value: string }> } },
  key: string,
): string | undefined => pair.metricKey.tags.find((t) => t.key === key)?.value

export const readWorkspaceMetrics = (opts: {
  readonly bus: AgentBus
  readonly fleets: number
  readonly startedAt: number
  readonly now: number
}): Effect.Effect<WorkspaceMetrics> =>
  Effect.gen(function* () {
    const pairs = yield* Metric.snapshot
    const byName = (name: string) => pairs.filter((p) => p.metricKey.name === name)
    const sum = (name: string) => byName(name).reduce((a, p) => a + pairCount(p), 0)

    // Tokens + cost, split by role.
    const tokensByRole: Record<string, { input: number; output: number; cache: number; costUsd: number }> = {}
    const role = (r: string | undefined) =>
      (tokensByRole[r ?? "main"] ??= { input: 0, output: 0, cache: 0, costUsd: 0 })
    for (const p of byName(METRIC_NAMES.tokens)) {
      const r = role(tagOf(p, "role"))
      const type = tagOf(p, "type")
      const c = pairCount(p)
      if (type === "input") r.input += c
      else if (type === "output") r.output += c
      else if (type === "cache") r.cache += c
    }
    let costUsdTotal = 0
    for (const p of byName(METRIC_NAMES.cost)) {
      const c = pairCount(p)
      role(tagOf(p, "role")).costUsd += c
      costUsdTotal += c
    }

    let toolCallsOk = 0
    let toolCallsFail = 0
    for (const p of byName(METRIC_NAMES.toolCalls)) {
      if (tagOf(p, "ok") === "true") toolCallsOk += pairCount(p)
      else toolCallsFail += pairCount(p)
    }
    let approvalsPrompted = 0
    for (const p of byName(METRIC_NAMES.approvalVerdicts)) {
      if (tagOf(p, "verdict") === "prompt") approvalsPrompted += pairCount(p)
    }

    // Live agent counts + message rate from the bus.
    const snap = yield* opts.bus.snapshot()
    const agentsRunning = snap.filter((a) => a.status === "running").length
    const board = yield* opts.bus.boardRead()
    const messagesPerMin = board.filter((n) => opts.now - n.at <= 60_000).length

    return {
      tokensByRole,
      costUsdTotal,
      agentsRunning,
      agentsDone: snap.length - agentsRunning,
      fleets: opts.fleets,
      turns: sum(METRIC_NAMES.turns),
      toolCallsOk,
      toolCallsFail,
      errors: sum(METRIC_NAMES.errors),
      approvalsPrompted,
      messagesPerMin,
      uptimeMs: Math.max(0, opts.now - opts.startedAt),
    } satisfies WorkspaceMetrics
  })
