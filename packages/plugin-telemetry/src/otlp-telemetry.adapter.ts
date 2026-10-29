import { Effect, Layer, Option } from "effect"
import type { Config } from "effect"
import { FetchHttpClient } from "effect/http"
import type { HttpClient } from "effect/http"
import { OtlpExporter, OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/observability"
import type { OtlpExport, OtlpProtocol, OtlpTelemetryOptions } from "./otlp-telemetry.entity.js"
import { otlpExportFromEnv, otlpExportOf } from "./otlp-telemetry.entity.functions.js"

const serialization = (protocol: OtlpProtocol): Layer.Layer<OtlpSerialization.OtlpSerialization> =>
  protocol === "http/json" ? OtlpSerialization.layerJson : OtlpSerialization.layerProtobuf

/**
 * Effect's OTLP tracer and metrics exporters for a resolved export: each
 * signal that has a URL, with one `Flusher` for both (`layerFlusher` is
 * memoized by reference, so the signals and the output share it).
 */
const exportLayer = (target: OtlpExport): Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient> => {
  const resource = {
    serviceName: target.serviceName,
    serviceVersion: Option.getOrUndefined(target.serviceVersion),
    attributes: target.resourceAttributes,
  }
  const shutdownTimeout = Option.getOrUndefined(target.shutdownTimeout)
  const traces = Option.map(target.traces, (signal) => OtlpTracer.layer({
    url: signal.url,
    resource,
    headers: signal.headers,
    compression: signal.compression,
    exportInterval: Option.getOrUndefined(signal.exportInterval),
    shutdownTimeout,
  }).pipe(Layer.provide(serialization(signal.protocol))))
  const metrics = Option.map(target.metrics, (signal) => OtlpMetrics.layer({
    url: signal.url,
    resource,
    headers: signal.headers,
    compression: signal.compression,
    exportInterval: Option.getOrUndefined(signal.exportInterval),
    shutdownTimeout,
    temporality: target.metricsTemporality,
  }).pipe(Layer.provide(serialization(signal.protocol))))
  return [traces, metrics].flatMap(Option.toArray).reduce(
    (merged: Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient>, signal) => Layer.merge(merged, signal),
    OtlpExporter.layerFlusher,
  )
}

/**
 * Export the program's spans and metrics over OTLP/HTTP with the host's
 * `HttpClient` (one that goes through a proxy, say): Effect's own
 * `OtlpTracer` and `OtlpMetrics` (`effect/observability`), configured by
 * `options` (`OtlpTelemetryOptions`). Provide it around the program that
 * defines the agent and runs its turns; it is the `Tracer` and the metrics
 * exporter of everything inside. Spans are batched and posted every
 * `exportInterval`; the metrics registry (every `Metric` the program
 * updated: the telemetry plugin's, the step loop's, the models plugin's,
 * `Agent.turn`'s) is posted whole each interval. Closing the layer posts
 * what is left, waiting up to `shutdownTimeout`; a serverless host flushes
 * before it responds (`flushTelemetry`). A failed export is retried and
 * then turns that signal off for 60 seconds; it never fails the program.
 */
export const OtlpTelemetryHttpLive = (options: OtlpTelemetryOptions): Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient> =>
  exportLayer(otlpExportOf(options))

/** `OtlpTelemetryHttpLive` over the global `fetch` (`FetchHttpClient`), on Node 24 and Bun. */
export const OtlpTelemetryLive = (options: OtlpTelemetryOptions): Layer.Layer<OtlpExporter.Flusher> =>
  OtlpTelemetryHttpLive(options).pipe(Layer.provide(FetchHttpClient.layer))

/**
 * OTLP export configured by the standard OpenTelemetry environment
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, the per-signal endpoints, headers,
 * compression and protocol, `OTEL_SERVICE_NAME`, `OTEL_SDK_DISABLED`, …;
 * see `otlpExportFromEnv`), over `defaults` for what it leaves unsaid,
 * with the host's `HttpClient`. With no endpoint, or with
 * `OTEL_SDK_DISABLED=true`, it exports nothing and reads nothing further,
 * so a host can always provide it. A variable it reads that is set to an
 * invalid value fails the layer with its `ConfigError`.
 */
export const OtlpTelemetryHttpFromEnv = (defaults: OtlpTelemetryOptions = {}): Layer.Layer<OtlpExporter.Flusher, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(otlpExportFromEnv(defaults).pipe(Effect.map(exportLayer)))

/** `OtlpTelemetryHttpFromEnv` over the global `fetch` (`FetchHttpClient`), on Node 24 and Bun. */
export const OtlpTelemetryFromEnv = (defaults: OtlpTelemetryOptions = {}): Layer.Layer<OtlpExporter.Flusher, Config.ConfigError> =>
  OtlpTelemetryHttpFromEnv(defaults).pipe(Layer.provide(FetchHttpClient.layer))

/**
 * Post every signal's pending batch now and wait for those posts (not for
 * one already in flight). It cannot fail; bound it with
 * `Effect.timeoutOption` where the host has a deadline.
 */
export const flushTelemetry: Effect.Effect<void, never, OtlpExporter.Flusher> =
  OtlpExporter.Flusher.pipe(Effect.flatMap((flusher) => flusher.flush))
