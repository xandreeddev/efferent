import { describe, expect, test } from "bun:test"
import { ConfigProvider, Duration, Effect, Exit, Option } from "effect"
import type { OtlpExport, OtlpTelemetryOptions } from "./otlp-telemetry.entity.js"
import { otlpExportFromEnv, otlpExportOf, signalUrl } from "./otlp-telemetry.entity.functions.js"

const fromEnv = (env: Record<string, string>, defaults: OtlpTelemetryOptions = {}): OtlpExport =>
  Effect.runSync(otlpExportFromEnv(defaults).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }))))
const failed = (env: Record<string, string>): string => {
  const exit = Effect.runSyncExit(otlpExportFromEnv().pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }))))
  return Exit.isFailure(exit) ? String(exit.cause) : "succeeded"
}
const urls = (target: OtlpExport) => [Option.getOrNull(Option.map(target.traces, (signal) => signal.url)), Option.getOrNull(Option.map(target.metrics, (signal) => signal.url))]

describe("signalUrl", () => {
  test("appends the signal's path with one slash, keeping the base path and query", () => {
    expect(signalUrl("http://collector:4318", "traces")).toBe("http://collector:4318/v1/traces")
    expect(signalUrl("http://collector:4318/", "metrics")).toBe("http://collector:4318/v1/metrics")
    expect(signalUrl("https://otlp.example/api/public/otel/?team=a", "traces")).toBe("https://otlp.example/api/public/otel/v1/traces?team=a")
  })
})

describe("otlpExportOf", () => {
  test("defaults: service efferent, protobuf, no compression, cumulative; a signal goes to its own URL, else under baseUrl", () => {
    const target = otlpExportOf({ baseUrl: "http://collector:4318", metricsUrl: "http://metrics:9000/push" })
    expect(urls(target)).toEqual(["http://collector:4318/v1/traces", "http://metrics:9000/push"])
    expect([target.serviceName, target.metricsTemporality]).toEqual(["efferent", "cumulative"])
    expect(Option.map(target.traces, (signal) => [signal.protocol, signal.compression, signal.headers])).toEqual(Option.some(["http/protobuf", "none", {}]))
  })

  test("service.name: serviceName, else resourceAttributes' service.name, else efferent; per-signal headers over the shared ones", () => {
    expect(otlpExportOf({ resourceAttributes: { "service.name": "api", "service.version": "3.1" } })).toMatchObject({ serviceName: "api", serviceVersion: Option.some("3.1") })
    expect(otlpExportOf({ serviceName: "named", resourceAttributes: { "service.name": "api" } }).serviceName).toBe("named")
    const target = otlpExportOf({ baseUrl: "http://collector:4318", headers: { "x-shared": "both", authorization: "shared" }, metricsHeaders: { authorization: "metrics-vendor" } })
    expect(Option.map(target.traces, (signal) => signal.headers)).toEqual(Option.some({ "x-shared": "both", authorization: "shared" }))
    expect(Option.map(target.metrics, (signal) => signal.headers)).toEqual(Option.some({ "x-shared": "both", authorization: "metrics-vendor" }))
  })

  test("a signal turned off, or with no URL, is not exported", () => {
    expect(urls(otlpExportOf({ baseUrl: "http://collector:4318", traces: false }))).toEqual([null, "http://collector:4318/v1/metrics"])
    expect(urls(otlpExportOf({ tracesUrl: "http://collector:4318/v1/traces" }))).toEqual(["http://collector:4318/v1/traces", null])
    expect(urls(otlpExportOf({}))).toEqual([null, null])
  })
})

describe("otlpExportFromEnv", () => {
  test("an empty environment exports nothing; the defaults' URLs are used when it names none", () => {
    expect(urls(fromEnv({}))).toEqual([null, null])
    expect(fromEnv({}).serviceName).toBe("efferent")
    expect(urls(fromEnv({}, { baseUrl: "http://fallback:4318" }))).toEqual(["http://fallback:4318/v1/traces", "http://fallback:4318/v1/metrics"])
  })

  test("the shared endpoint gets each signal's path; a signal's own endpoint is used as given and wins", () => {
    expect(urls(fromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }, { baseUrl: "http://fallback:4318" })))
      .toEqual(["http://collector:4318/v1/traces", "http://collector:4318/v1/metrics"])
    expect(urls(fromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/otlp", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces:4318/custom" })))
      .toEqual(["http://traces:4318/custom", "http://collector:4318/otlp/v1/metrics"])
    expect(urls(fromEnv({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://metrics:4318/v1/metrics" }))).toEqual([null, "http://metrics:4318/v1/metrics"])
  })

  test("OTEL_SDK_DISABLED and the signals' exporters turn export off; an exporter list without otlp does too", () => {
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }
    expect(urls(fromEnv({ ...endpoint, OTEL_SDK_DISABLED: "true" }))).toEqual([null, null])
    expect(urls(fromEnv({ ...endpoint, OTEL_TRACES_EXPORTER: "none" }))).toEqual([null, "http://collector:4318/v1/metrics"])
    expect(urls(fromEnv({ ...endpoint, OTEL_METRICS_EXPORTER: "prometheus" }))).toEqual(["http://collector:4318/v1/traces", null])
    expect(urls(fromEnv({ ...endpoint, OTEL_TRACES_EXPORTER: "console, OTLP" }))).toEqual(["http://collector:4318/v1/traces", "http://collector:4318/v1/metrics"])
    // Unset, the defaults decide.
    expect(urls(fromEnv(endpoint, { traces: false }))).toEqual([null, "http://collector:4318/v1/metrics"])
  })

  test("headers: the signal's own over the shared ones over the defaults', values URL-decoded", () => {
    const target = fromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "x-tenant=acme%20co, x-shared=env",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-shared=traces",
    }, { headers: { "x-shared": "default", "x-default": "kept" }, metricsHeaders: { "x-metrics": "default" } })
    expect(Option.map(target.traces, (signal) => signal.headers)).toEqual(Option.some({ "x-shared": "traces", "x-default": "kept", "x-tenant": "acme co" }))
    expect(Option.map(target.metrics, (signal) => signal.headers)).toEqual(Option.some({ "x-shared": "env", "x-default": "kept", "x-metrics": "default", "x-tenant": "acme co" }))
  })

  test("compression, protocol and intervals: the signal's own, then the shared, then the defaults", () => {
    const target = fromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_COMPRESSION: "gzip",
      OTEL_EXPORTER_OTLP_METRICS_COMPRESSION: "none",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      OTEL_METRIC_EXPORT_INTERVAL: "2500",
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "lowmemory",
    }, { protocol: "http/protobuf", exportInterval: "30 seconds" })
    expect(Option.map(target.traces, (signal) => [signal.compression, signal.protocol])).toEqual(Option.some(["gzip", "http/json"]))
    expect(Option.map(target.metrics, (signal) => [signal.compression, signal.protocol])).toEqual(Option.some(["none", "http/protobuf"]))
    expect(Option.flatMap(target.metrics, (signal) => Option.map(signal.exportInterval, Duration.toMillis))).toEqual(Option.some(2500))
    expect(Option.flatMap(target.traces, (signal) => Option.map(signal.exportInterval, Duration.toMillis))).toEqual(Option.some(30_000))
    expect(target.metricsTemporality).toBe("delta")
  })

  test("service.name: OTEL_SERVICE_NAME, then OTEL_RESOURCE_ATTRIBUTES, then the defaults; the environment's attributes win", () => {
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }
    expect(fromEnv({ ...endpoint, OTEL_SERVICE_NAME: "named", OTEL_RESOURCE_ATTRIBUTES: "service.name=attributed" }, { serviceName: "default" }).serviceName).toBe("named")
    const attributed = fromEnv({ ...endpoint, OTEL_RESOURCE_ATTRIBUTES: "service.name=attributed,service.version=2.1,team=agents" }, { serviceName: "default", serviceVersion: "1.0", resourceAttributes: { team: "default", region: "eu" } })
    expect([attributed.serviceName, Option.getOrNull(attributed.serviceVersion)]).toEqual(["attributed", "2.1"])
    expect(attributed.resourceAttributes).toMatchObject({ team: "agents", region: "eu" })
    expect(Option.getOrNull(fromEnv({ ...endpoint, OTEL_SERVICE_VERSION: "3.0", OTEL_RESOURCE_ATTRIBUTES: "service.version=2.1" }, { serviceVersion: "1.0" }).serviceVersion)).toBe("3.0")
    expect(fromEnv(endpoint, { serviceName: "default" }).serviceName).toBe("default")
    expect(fromEnv(endpoint, { resourceAttributes: { "service.name": "from-attributes" } }).serviceName).toBe("from-attributes")
  })

  test("a variable that is read and set to a value it cannot use fails, naming it", () => {
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }
    expect(failed({ ...endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" })).toContain("OTEL_EXPORTER_OTLP_PROTOCOL")
    expect(failed({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "not a url" })).toContain("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    expect(failed({ ...endpoint, OTEL_EXPORTER_OTLP_COMPRESSION: "brotli" })).toContain("OTEL_EXPORTER_OTLP_COMPRESSION")
    expect(failed({ ...endpoint, OTEL_EXPORTER_OTLP_HEADERS: "x-quota=50%" })).toContain("OTEL_EXPORTER_OTLP_HEADERS")
    expect(failed({ ...endpoint, OTEL_RESOURCE_ATTRIBUTES: "team=50%" })).toContain("OTEL_RESOURCE_ATTRIBUTES")
  })

  test("reads nothing it does not need: disabled, off or without an endpoint, invalid values elsewhere do not fail", () => {
    const invalid = { OTEL_EXPORTER_OTLP_PROTOCOL: "grpc", OTEL_EXPORTER_OTLP_HEADERS: "x-quota=50%", OTEL_RESOURCE_ATTRIBUTES: "team=50%", OTEL_METRIC_EXPORT_INTERVAL: "soon" }
    expect(failed({ ...invalid, OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" })).toBe("succeeded")
    expect(failed(invalid)).toBe("succeeded")
    expect(failed({ ...invalid, OTEL_EXPORTER_OTLP_ENDPOINT: "not a url", OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "none" })).toBe("succeeded")
    // A signal's own valid setting is read first, so the shared invalid one is never read.
    const own = fromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "not a url",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces:4318/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      OTEL_METRICS_EXPORTER: "none",
    })
    expect(urls(own)).toEqual(["http://traces:4318/v1/traces", null])
    expect(Option.map(own.traces, (signal) => signal.protocol)).toEqual(Option.some("http/json"))
  })
})
