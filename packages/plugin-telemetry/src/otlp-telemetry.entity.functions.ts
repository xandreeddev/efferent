import { Config, Duration, Effect, Option, Schema } from "effect"
import { DEFAULT_SERVICE_NAME, OtlpCompression, OtlpProtocol } from "./otlp-telemetry.entity.js"
import type { OtlpExport, OtlpSignal, OtlpSignalExport, OtlpTelemetryOptions, OtlpTemporality } from "./otlp-telemetry.entity.js"

/**
 * A signal's URL under a collector's base URL: its path plus `/v1/traces`
 * or `/v1/metrics` (one slash between), the query string kept.
 */
export const signalUrl = (base: string, signal: OtlpSignal): string => Option.match(Option.fromNullishOr(URL.parse(base)), {
  onNone: () => `${base.replace(/\/+$/, "")}/v1/${signal}`,
  onSome: (url) => {
    const target = new URL(url)
    target.pathname = `${target.pathname.replace(/\/+$/, "")}/v1/${signal}`
    return target.toString()
  },
})

/** The options naming one signal: whether it is on, its own URL and its own headers. */
const signalOptions = (options: OtlpTelemetryOptions, signal: OtlpSignal) => signal === "traces"
  ? { enabled: options.traces, url: options.tracesUrl, headers: options.tracesHeaders }
  : { enabled: options.metrics, url: options.metricsUrl, headers: options.metricsHeaders }

/** A signal's URL from the options: its own, else under `baseUrl`. */
const optionsUrl = (options: OtlpTelemetryOptions, signal: OtlpSignal): Option.Option<string> => Option.firstSomeOf([
  Option.fromNullishOr(signalOptions(options, signal).url),
  Option.map(Option.fromNullishOr(options.baseUrl), (base) => signalUrl(base, signal)),
])

/** A signal's headers from the options: its own over the shared `headers`. */
const optionsHeaders = (options: OtlpTelemetryOptions, signal: OtlpSignal): Readonly<Record<string, string>> =>
  ({ ...options.headers, ...signalOptions(options, signal).headers })

/** The resource the options describe: `service.name` is `serviceName`, else `resourceAttributes["service.name"]`, else `"efferent"`. */
const optionsResource = (options: OtlpTelemetryOptions): Pick<OtlpExport, "serviceName" | "serviceVersion" | "resourceAttributes"> => {
  const attributes = options.resourceAttributes ?? {}
  return {
    serviceName: options.serviceName ?? attributes["service.name"] ?? DEFAULT_SERVICE_NAME,
    serviceVersion: Option.fromNullishOr(options.serviceVersion ?? attributes["service.version"]),
    resourceAttributes: attributes,
  }
}

/** The export `OtlpTelemetryLive` builds from its options (see `OtlpTelemetryOptions` for the defaults). */
export const otlpExportOf = (options: OtlpTelemetryOptions): OtlpExport => {
  const signal = (name: OtlpSignal): Option.Option<OtlpSignalExport> =>
    signalOptions(options, name).enabled === false ? Option.none() : Option.map(optionsUrl(options, name), (url) => ({
      url,
      headers: optionsHeaders(options, name),
      compression: options.compression ?? "none",
      protocol: options.protocol ?? "http/protobuf",
      exportInterval: Option.fromNullishOr(options.exportInterval),
    }))
  return {
    ...optionsResource(options),
    traces: signal("traces"),
    metrics: signal("metrics"),
    metricsTemporality: options.metricsTemporality ?? "cumulative",
    shutdownTimeout: Option.fromNullishOr(options.shutdownTimeout),
  }
}

/**
 * A comma-separated `key=value` list whose values (and, with `decodeKeys`,
 * keys) are URL-encoded (`OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_RESOURCE_ATTRIBUTES`), trimmed.
 */
const keyValues = (name: string, decodeKeys = false): Config.Config<Option.Option<Readonly<Record<string, string>>>> =>
  Config.option(Config.Record(decodeKeys ? Schema.StringFromUriComponent : Schema.String, Schema.StringFromUriComponent, name)).pipe(
    Config.map(Option.map((record) => Object.fromEntries(Object.entries(record)
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .filter(([key]) => key.length > 0)))),
  )

/** The first of `configs` that is set, read in order: a later one is read (and can fail) only when every earlier one is unset. */
const firstSet = <A>(configs: ReadonlyArray<Config.Config<Option.Option<A>>>): Effect.Effect<Option.Option<A>, Config.ConfigError> =>
  configs.reduce(
    (found: Effect.Effect<Option.Option<A>, Config.ConfigError>, next) => Effect.flatMap(found, (value) => Option.isSome(value) ? Effect.succeed(value) : next),
    Effect.succeed(Option.none()),
  )

/** `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`; `lowmemory` reports counters and histograms as deltas, which is all these metrics are. */
const temporalityPreference = Config.option(Config.Literals(["cumulative", "delta", "lowmemory"], "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE")).pipe(
  Config.map(Option.map((value): OtlpTemporality => value === "cumulative" ? "cumulative" : "delta")),
)

/** The variable holding a signal's export interval in milliseconds. */
const intervalVariable: Record<OtlpSignal, string> = { traces: "OTEL_BSP_SCHEDULE_DELAY", metrics: "OTEL_METRIC_EXPORT_INTERVAL" }

/**
 * One signal's export from the environment over `defaults`, or `None` when
 * it is not exported. Its exporter list is read first, then its endpoint;
 * its headers, compression, protocol and interval only once it has one.
 */
const signalFromEnv = (name: OtlpSignal, defaults: OtlpTelemetryOptions): Effect.Effect<Option.Option<OtlpSignalExport>, Config.ConfigError> => Effect.gen(function* () {
  const upper = name.toUpperCase()
  const own = `OTEL_EXPORTER_OTLP_${upper}_`
  const exporters = (yield* Config.Array(Schema.String, `OTEL_${upper}_EXPORTER`).pipe(Config.withDefault<ReadonlyArray<string>>([])))
    .map((exporter) => exporter.trim().toLowerCase()).filter((exporter) => exporter.length > 0)
  const on = exporters.length > 0 ? exporters.includes("otlp") : signalOptions(defaults, name).enabled !== false
  const url = on
    ? Option.orElse(yield* firstSet([
      Config.option(Config.URL(`${own}ENDPOINT`)).pipe(Config.map(Option.map((endpoint) => endpoint.toString()))),
      Config.option(Config.URL("OTEL_EXPORTER_OTLP_ENDPOINT")).pipe(Config.map(Option.map((endpoint) => signalUrl(endpoint.toString(), name)))),
    ]), () => optionsUrl(defaults, name))
    : Option.none<string>()
  return Option.isNone(url) ? Option.none() : Option.some<OtlpSignalExport>({
    url: url.value,
    headers: {
      ...optionsHeaders(defaults, name),
      ...Option.getOrElse(yield* keyValues("OTEL_EXPORTER_OTLP_HEADERS"), () => ({})),
      ...Option.getOrElse(yield* keyValues(`${own}HEADERS`), () => ({})),
    },
    compression: Option.getOrElse(
      yield* firstSet([Config.option(Config.schema(OtlpCompression, `${own}COMPRESSION`)), Config.option(Config.schema(OtlpCompression, "OTEL_EXPORTER_OTLP_COMPRESSION"))]),
      () => defaults.compression ?? "none",
    ),
    protocol: Option.getOrElse(
      yield* firstSet([Config.option(Config.schema(OtlpProtocol, `${own}PROTOCOL`)), Config.option(Config.schema(OtlpProtocol, "OTEL_EXPORTER_OTLP_PROTOCOL"))]),
      () => defaults.protocol ?? "http/protobuf",
    ),
    exportInterval: Option.orElse(
      Option.map(yield* Config.option(Config.Int(intervalVariable[name])), Duration.millis),
      () => Option.fromNullishOr(defaults.exportInterval),
    ),
  })
})

/**
 * The export the standard OpenTelemetry environment describes, over
 * `defaults` for what it leaves unsaid (read from the current
 * `ConfigProvider`, the process environment by default):
 * - `OTEL_SDK_DISABLED=true` exports nothing, and `OTEL_TRACES_EXPORTER` /
 *   `OTEL_METRICS_EXPORTER` export that signal only when they list `otlp`
 *   (`none` turns it off; unset leaves `defaults.traces`/`metrics`, on);
 * - a signal's endpoint is `OTEL_EXPORTER_OTLP_{TRACES,METRICS}_ENDPOINT`
 *   as given, else `OTEL_EXPORTER_OTLP_ENDPOINT` plus `/v1/<signal>`, else
 *   the defaults' URLs; a signal with no endpoint is not exported, so an
 *   empty environment exports nothing;
 * - headers are `OTEL_EXPORTER_OTLP_HEADERS` with the signal's own
 *   `..._{TRACES,METRICS}_HEADERS` over them, over the defaults' headers;
 *   compression and protocol are the signal's own variable, else the
 *   shared one, else the defaults (`none`, `http/protobuf`; `grpc` fails);
 * - `service.name` is `OTEL_SERVICE_NAME`, else `OTEL_RESOURCE_ATTRIBUTES`'
 *   `service.name`, else `defaults.serviceName`, else the defaults'
 *   `resourceAttributes["service.name"]`, else `"efferent"`;
 *   `service.version` likewise from `OTEL_SERVICE_VERSION`;
 *   `OTEL_RESOURCE_ATTRIBUTES` win over `defaults.resourceAttributes`;
 * - the export intervals are `OTEL_BSP_SCHEDULE_DELAY` (traces) and
 *   `OTEL_METRIC_EXPORT_INTERVAL` (metrics), in milliseconds, and the
 *   temporality `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`;
 *   `OTEL_EXPORTER_OTLP_TIMEOUT` is not read (`shutdownTimeout` is the
 *   defaults').
 * A variable is read only when it can matter: nothing past
 * `OTEL_SDK_DISABLED` when it is set, nothing about a signal past its
 * exporter list when that turns it off, and nothing past the endpoints
 * when no signal has one; a signal's own endpoint, compression and
 * protocol are read before the shared ones, which are not read when the
 * signal's are set (headers merge, so both are read). A variable that
 * is read and set to a value it cannot use fails with its `ConfigError`.
 */
export const otlpExportFromEnv = (defaults: OtlpTelemetryOptions = {}): Effect.Effect<OtlpExport, Config.ConfigError> => Effect.gen(function* () {
  const disabled = yield* Config.Boolean("OTEL_SDK_DISABLED").pipe(Config.withDefault(false))
  const traces = disabled ? Option.none<OtlpSignalExport>() : yield* signalFromEnv("traces", defaults)
  const metrics = disabled ? Option.none<OtlpSignalExport>() : yield* signalFromEnv("metrics", defaults)
  const base = optionsResource(defaults)
  const exporting = Option.isSome(traces) || Option.isSome(metrics)
  const resource = exporting ? Option.getOrElse(yield* keyValues("OTEL_RESOURCE_ATTRIBUTES", true), (): Readonly<Record<string, string>> => ({})) : {}
  const serviceName = exporting ? yield* Config.option(Config.String("OTEL_SERVICE_NAME")) : Option.none<string>()
  const serviceVersion = exporting ? yield* Config.option(Config.String("OTEL_SERVICE_VERSION")) : Option.none<string>()
  const temporality = Option.isSome(metrics) ? yield* temporalityPreference : Option.none<OtlpTemporality>()
  return {
    serviceName: Option.getOrElse(Option.firstSomeOf([serviceName, Option.fromNullishOr(resource["service.name"])]), () => base.serviceName),
    serviceVersion: Option.firstSomeOf([serviceVersion, Option.fromNullishOr(resource["service.version"]), base.serviceVersion]),
    resourceAttributes: { ...base.resourceAttributes, ...resource },
    traces,
    metrics,
    metricsTemporality: Option.getOrElse(temporality, () => defaults.metricsTemporality ?? "cumulative"),
    shutdownTimeout: Option.fromNullishOr(defaults.shutdownTimeout),
  }
})
