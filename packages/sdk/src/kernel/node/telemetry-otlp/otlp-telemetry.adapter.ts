import { Effect, Layer, Option, Tracer } from "effect"
import type { Config } from "effect"
import { Telemetry } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import type { HttpClient } from "effect/http"
import { OtlpExporter, OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/observability"
import { answerContentOf, sentContentOf } from "./content.entity.functions.js"
import { spanPolicyTracer } from "./span-policy.adapter.js"
import type { OtlpExport, OtlpProtocol, OtlpSpanPolicy, OtlpTelemetryOptions } from "./otlp-telemetry.entity.js"
import { exportPolicyOf, otlpExportFromEnv, otlpExportOf } from "./otlp-telemetry.entity.functions.js"

const serialization = (protocol: OtlpProtocol): Layer.Layer<OtlpSerialization.OtlpSerialization> =>
  protocol === "http/json" ? OtlpSerialization.layerJson : OtlpSerialization.layerProtobuf

/**
 * Effect's OTLP tracer and metrics exporters for a resolved export: each
 * signal that has a URL, with one `Flusher` for both (`layerFlusher` is
 * memoized by reference, so the signals and the output share it). The
 * tracer is Effect's OTLP tracer behind the export's policy: the host's,
 * behind the content rule (`exportPolicyOf`). With `content` on, the layer
 * also gives the program Effect AI's `CurrentSpanTransformer`, which puts
 * each model call's prompt and answer on its span; its type names the
 * `Flusher` alone, so a host's own transformer, provided inside, wins.
 */
const exportLayer = (target: OtlpExport, spans: Option.Option<OtlpSpanPolicy>, content: boolean): Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient> => {
  const resource = {
    serviceName: target.serviceName,
    serviceVersion: Option.getOrUndefined(target.serviceVersion),
    attributes: target.resourceAttributes,
  }
  const shutdownTimeout = Option.getOrUndefined(target.shutdownTimeout)
  const traces = Option.map(target.traces, (signal) => {
    const options = {
      url: signal.url,
      resource,
      headers: signal.headers,
      compression: signal.compression,
      exportInterval: Option.getOrUndefined(signal.exportInterval),
      shutdownTimeout,
    }
    return OtlpTracer.make(options).pipe(
      Effect.map(spanPolicyTracer(exportPolicyOf(spans, content))),
      Layer.effect(Tracer.Tracer),
      Layer.provideMerge(OtlpExporter.layerFlusher),
    ).pipe(Layer.provide(serialization(signal.protocol)))
  })
  const metrics = Option.map(target.metrics, (signal) => OtlpMetrics.layer({
    url: signal.url,
    resource,
    headers: signal.headers,
    compression: signal.compression,
    exportInterval: Option.getOrUndefined(signal.exportInterval),
    shutdownTimeout,
    temporality: target.metricsTemporality,
  }).pipe(Layer.provide(serialization(signal.protocol))))
  const exported = [traces, metrics].flatMap(Option.toArray).reduce(
    (merged: Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient>, signal) => Layer.merge(merged, signal),
    OtlpExporter.layerFlusher,
  )
  return content ? Layer.merge(exported, Layer.succeed(Telemetry.CurrentSpanTransformer, contentOnSpan)) : exported
}

/** A value as the text an attribute holds: its JSON, or a note when it has none (a cycle, a big integer). */
const jsonOf = (value: unknown): string =>
  Option.getOrElse(Option.liftThrowable((held: unknown) => JSON.stringify(held))(value), () => "[content that cannot be written as JSON]")

/**
 * A model call's prompt and answer on its span, as OpenTelemetry's generative AI conventions name them: the system
 * text (`gen_ai.system_instructions`), the conversation sent (`gen_ai.input.messages`, a tool's result among it) and
 * the answer (`gen_ai.output.messages`). Effect AI runs it as each call's stream ends, before its span does.
 */
const contentOnSpan: Telemetry.SpanTransformer = ({ prompt, response, span }) => {
  const sent = sentContentOf(prompt)
  if (sent.system.length > 0) span.attribute("gen_ai.system_instructions", jsonOf(sent.system))
  span.attribute("gen_ai.input.messages", jsonOf(sent.messages))
  span.attribute("gen_ai.output.messages", jsonOf(answerContentOf(response)))
}

/**
 * Export the program's spans and metrics over OTLP/HTTP with the host's
 * `HttpClient` (one that goes through a proxy, say): Effect's own
 * `OtlpTracer` and `OtlpMetrics` (`effect/observability`), configured by
 * `options` (`OtlpTelemetryOptions`). Provide it around the program that
 * builds the kernel's stack and runs its turns; it is the `Tracer` and the
 * metrics exporter of everything inside. Spans are batched and posted every
 * `exportInterval`; the metrics registry (every `Metric` the program
 * updated: the kernel's `efferent.model.*` and `efferent.tool.calls`, the
 * host's own) is posted whole each interval. Closing the layer posts
 * what is left, waiting up to `shutdownTimeout`; a serverless host flushes
 * before it responds (`flushTelemetry`). A failed export is retried and
 * then turns that signal off for 60 seconds; it never fails the program.
 * What was said is left out unless `options.content` is on (ADR 0030);
 * `options.spans` (`OtlpSpanPolicy`) drops spans and leaves attributes
 * out before they reach the exporter.
 *
 * @public
 */
export const otlpTelemetryOver = (options: OtlpTelemetryOptions): Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient> =>
  exportLayer(otlpExportOf(options), Option.fromNullishOr(options.spans), options.content === true)

/**
 * `otlpTelemetryOver` over the global `fetch` (`FetchHttpClient`), on Node 24 and Bun.
 *
 * @public
 */
export const otlpTelemetry = (options: OtlpTelemetryOptions): Layer.Layer<OtlpExporter.Flusher> =>
  otlpTelemetryOver(options).pipe(Layer.provide(FetchHttpClient.layer))

/**
 * OTLP export configured by the standard OpenTelemetry environment
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, the per-signal endpoints, headers,
 * compression and protocol, `OTEL_SERVICE_NAME`, `OTEL_SDK_DISABLED`, …;
 * see `otlpExportFromEnv`), over `defaults` for what it leaves unsaid,
 * with the host's `HttpClient`. With no endpoint, or with
 * `OTEL_SDK_DISABLED=true`, it exports nothing and reads nothing further,
 * so a host can always provide it. A variable it reads that is set to an
 * invalid value fails the layer with its `ConfigError`. No variable sets
 * a span policy: `defaults.spans` applies whatever the environment says.
 *
 * @public
 */
export const otlpTelemetryFromEnvOver = (defaults: OtlpTelemetryOptions = {}): Layer.Layer<OtlpExporter.Flusher, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(otlpExportFromEnv(defaults).pipe(Effect.map((target) => exportLayer(target, Option.fromNullishOr(defaults.spans), defaults.content === true))))

/**
 * `otlpTelemetryFromEnvOver` over the global `fetch` (`FetchHttpClient`), on Node 24 and Bun.
 *
 * @public
 */
export const otlpTelemetryFromEnv = (defaults: OtlpTelemetryOptions = {}): Layer.Layer<OtlpExporter.Flusher, Config.ConfigError> =>
  otlpTelemetryFromEnvOver(defaults).pipe(Layer.provide(FetchHttpClient.layer))

/**
 * Post every signal's pending batch now and wait for those posts (not for
 * one already in flight). It cannot fail; bound it with
 * `Effect.timeoutOption` where the host has a deadline.
 *
 * @public
 */
export const flushTelemetry: Effect.Effect<void, never, OtlpExporter.Flusher> =
  OtlpExporter.Flusher.pipe(Effect.flatMap((flusher) => flusher.flush))
