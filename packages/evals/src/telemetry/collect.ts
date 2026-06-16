import { NodeSdk } from "@effect/opentelemetry"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { type MetricReader, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import type { Layer } from "effect"

/**
 * Telemetry for an eval run. An `InMemorySpanExporter` is ALWAYS wired up — the
 * runner reads its finished spans to build the report (works with no Docker).
 * When an OTLP endpoint is given, a batch OTLP processor + metric reader are
 * ALSO attached, so the same run lights up Grafana (trace waterfall + metrics).
 */
export interface Collector {
  readonly layer: Layer.Layer<never>
  readonly getSpans: () => ReadonlyArray<ReadableSpan>
}

export const makeCollector = (otlpEndpoint?: string, runId?: string): Collector => {
  const exporter = new InMemorySpanExporter()
  const processors: Array<SpanProcessor> = [new SimpleSpanProcessor(exporter)]
  const metricReaders: Array<MetricReader> = []
  if (otlpEndpoint !== undefined && otlpEndpoint.length > 0) {
    processors.push(
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` })),
    )
    metricReaders.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }),
        exportIntervalMillis: 2000,
      }),
    )
  }
  const layer = NodeSdk.layer(() => ({
    // serviceName `efferent-evals` (→ Prometheus `job` label) keeps eval data
    // disjoint from a real session's `efferent`; the env attr mirrors the split.
    // `eval.run_id` is a RESOURCE attr (not just on the eval.run span) so it is
    // queryable on every span of the run — the eval dashboard filters the
    // eval.case trace list by `resource.eval.run_id`.
    resource: {
      serviceName: "efferent-evals",
      attributes: {
        "deployment.environment": "eval",
        ...(runId !== undefined ? { "eval.run_id": runId } : {}),
      },
    },
    spanProcessor: processors,
    ...(metricReaders.length > 0 ? { metricReader: metricReaders } : {}),
  })) as Layer.Layer<never>
  return { layer, getSpans: () => exporter.getFinishedSpans() }
}
