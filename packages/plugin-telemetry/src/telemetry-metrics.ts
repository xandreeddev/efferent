import { Metric } from "effect"

/**
 * The metrics the telemetry plugin records, as Effect `Metric`s (a metric's
 * name, description and attributes are its identity in the registry, so a
 * dashboard or test reads them through these definitions). Every one also
 * carries the plugin's `metricAttributes`; none carries a session, run or
 * turn id.
 *
 * | Metric | Attributes | Counts |
 * |---|---|---|
 * | `efferent.llm.tokens` | `efferent.model`, `efferent.token.kind` | tokens of each response, by billed kind (`input`, `cache_read`, `cache_write`, `reasoning`, `output`; they sum to the response's total) |
 * | `efferent.llm.cost` | `efferent.model` | what each priced response cost, in the prices' currency |
 * | `efferent.steps` | `efferent.step.status` | steps of the step loop, by how they ended (`completed`, `failed`, `cancelled`, `malformed`: a response the model could not form, answered with a corrective turn, or `truncated`: a response cut short, none of whose tool calls ran) |
 * | `efferent.tool.calls` | `efferent.tool`, `efferent.ok` | tool calls whose handler ran, by result |
 * | `efferent.tool.duration` | `efferent.tool`, `efferent.ok` | those calls' time in milliseconds, from `tool.started` to the handler's exit |
 * | `efferent.tool.refused` | `efferent.tool`, `efferent.refusal.reason` | calls the tool registry refused before the handler ran |
 * | `efferent.stream.fallbacks` | — | streamed model calls that failed before their first part and were answered by a non-streamed call |
 *
 * @public
 */
export const TelemetryMetrics = {
  tokens: Metric.counter("efferent.llm.tokens", {
    description: "tokens of each model response, by billed kind",
    incremental: true,
  }),
  cost: Metric.counter("efferent.llm.cost", {
    description: "cost of each priced model response, in the prices' currency",
    incremental: true,
  }),
  steps: Metric.counter("efferent.steps", {
    description: "steps of the step loop, by how they ended",
    incremental: true,
  }),
  toolCalls: Metric.counter("efferent.tool.calls", {
    description: "tool calls whose handler ran, by result",
    incremental: true,
  }),
  toolDuration: Metric.timer("efferent.tool.duration", {
    description: "time of each tool call whose handler ran, in milliseconds",
    boundaries: [10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000],
  }),
  toolRefused: Metric.counter("efferent.tool.refused", {
    description: "tool calls the registry refused before the handler ran, by reason",
    incremental: true,
  }),
  streamFallbacks: Metric.counter("efferent.stream.fallbacks", {
    description: "streamed model calls that fell back to a non-streamed call",
    incremental: true,
  }),
} as const
