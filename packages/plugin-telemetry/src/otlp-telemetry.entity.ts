import { Schema } from "effect"
import type { Duration, Option, Tracer } from "effect"

/**
 * How a signal's batches are encoded: OTLP/HTTP protobuf (the OpenTelemetry default) or JSON. gRPC is not supported.
 *
 * @public
 */
export const OtlpProtocol = Schema.Literals(["http/protobuf", "http/json"])
export type OtlpProtocol = typeof OtlpProtocol.Type

/**
 * Request compression; gzip leaves a batch under 1 KB uncompressed.
 *
 * @public
 */
export const OtlpCompression = Schema.Literals(["gzip", "none"])
export type OtlpCompression = typeof OtlpCompression.Type

/**
 * How counters and histograms are reported: totals since the start (`cumulative`) or since the last export (`delta`).
 *
 * @public
 */
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
 * - `spans`: what of each span the traces export sends (`OtlpSpanPolicy`);
 *   every span, whole, by default.
 *
 * @public
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
  readonly spans?: OtlpSpanPolicy
}

/**
 * What the traces export sends of each span, for a host with an export
 * policy (attribute allow-lists, metadata-only traces for sensitive work).
 * Both hooks are synchronous, read the span they are given and leave it
 * as it is; a hook that throws drops what it was asked about. The span
 * they read, like the one the program holds, has every attribute set on
 * it: the policy filters what is sent, not what the program sees.
 * - `keep`: whether the span is sent. It runs once per span, when the
 *   span's first child starts or else when it ends, and sees the
 *   attributes the span has then (those it was opened with at least). A
 *   dropped span is never sent; its
 *   children are sent under its nearest kept ancestor (the children of a
 *   dropped root start traces of their own). Every span by default.
 * - `attribute`: the value a span attribute or a span event's attribute
 *   is sent with, `Option.none()` to leave it out. It runs as the
 *   attribute is set (the span already holding it), so a value it leaves
 *   out never reaches the exporter. Every attribute as it is by default.
 *
 * Span and event names, links, and the status and `exception` events a
 * failed span gets from its exit are sent as they are.
 *
 * @public
 */
export interface OtlpSpanPolicy {
  readonly keep?: (span: Tracer.Span) => boolean
  readonly attribute?: (span: Tracer.Span, key: string, value: unknown) => Option.Option<unknown>
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
