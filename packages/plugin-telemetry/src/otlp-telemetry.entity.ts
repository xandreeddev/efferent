import { Schema } from "effect"
import type { Duration, Option } from "effect"

/** How a signal's batches are encoded: OTLP/HTTP protobuf (the OpenTelemetry default) or JSON. gRPC is not supported. */
export const OtlpProtocol = Schema.Literals(["http/protobuf", "http/json"])
export type OtlpProtocol = typeof OtlpProtocol.Type

/** Request compression; gzip leaves a batch under 1 KB uncompressed. */
export const OtlpCompression = Schema.Literals(["gzip", "none"])
export type OtlpCompression = typeof OtlpCompression.Type

/** How counters and histograms are reported: totals since the start (`cumulative`) or since the last export (`delta`). */
export const OtlpTemporality = Schema.Literals(["cumulative", "delta"])
export type OtlpTemporality = typeof OtlpTemporality.Type

/** The signals the layers export; logs are left to the host. */
export type OtlpSignal = "traces" | "metrics"

/**
 * Where and how `OtlpTelemetryLive` exports traces and metrics over
 * OTLP/HTTP. A signal goes to its own URL (`tracesUrl`, `metricsUrl`, used
 * as given) or else to `baseUrl` plus `/v1/traces` or `/v1/metrics`; a
 * signal with neither, or turned off (`traces: false`, `metrics: false`),
 * is not exported.
 * - `serviceName`: the resource's `service.name`; else
 *   `resourceAttributes["service.name"]`, else `"efferent"`. It always
 *   wins over `OTEL_SERVICE_NAME` and the `service.name` of
 *   `OTEL_RESOURCE_ATTRIBUTES` (`OtlpTelemetryFromEnv` reads those).
 *   `serviceVersion` (else `resourceAttributes["service.version"]`) and
 *   `resourceAttributes` join the resource, over any other
 *   `OTEL_RESOURCE_ATTRIBUTES` Effect's exporter still merges in; with no
 *   `serviceVersion` at all, Effect's exporter reads `OTEL_SERVICE_VERSION`.
 * - `headers`: sent with every request (an API key, a tenant), both
 *   signals; `tracesHeaders` and `metricsHeaders` go to one signal only,
 *   over `headers` (a signal at another vendor, with its own key).
 * - `compression`: `"none"` by default; `protocol`: `"http/protobuf"` by default.
 * - `exportInterval`: how often batches are sent (Effect's defaults: 5 s for
 *   traces, 10 s for metrics); `shutdownTimeout`: how long closing the layer
 *   waits for the last export (3 s).
 * - `metricsTemporality`: `"cumulative"` by default.
 */
export interface OtlpTelemetryOptions {
  readonly baseUrl?: string
  readonly tracesUrl?: string
  readonly metricsUrl?: string
  readonly traces?: boolean
  readonly metrics?: boolean
  readonly serviceName?: string
  readonly serviceVersion?: string
  readonly resourceAttributes?: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
  readonly tracesHeaders?: Readonly<Record<string, string>>
  readonly metricsHeaders?: Readonly<Record<string, string>>
  readonly compression?: OtlpCompression
  readonly protocol?: OtlpProtocol
  readonly exportInterval?: Duration.Input
  readonly shutdownTimeout?: Duration.Input
  readonly metricsTemporality?: OtlpTemporality
}

/** One signal's export, resolved: the URL it is posted to and how. */
export interface OtlpSignalExport {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly compression: OtlpCompression
  readonly protocol: OtlpProtocol
  readonly exportInterval: Option.Option<Duration.Input>
}

/** The export the layers build, resolved from options or the environment: a signal that is `None` is not exported. */
export interface OtlpExport {
  readonly serviceName: string
  readonly serviceVersion: Option.Option<string>
  readonly resourceAttributes: Readonly<Record<string, string>>
  readonly traces: Option.Option<OtlpSignalExport>
  readonly metrics: Option.Option<OtlpSignalExport>
  readonly metricsTemporality: OtlpTemporality
  readonly shutdownTimeout: Option.Option<Duration.Input>
}

/** The service name a resource gets when nothing names one. */
export const DEFAULT_SERVICE_NAME = "efferent"
