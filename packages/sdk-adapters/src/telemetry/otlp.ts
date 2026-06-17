import { Otlp } from "@effect/opentelemetry"
import { Config, Effect, Layer } from "effect"
import { FetchHttpClientLive } from "../llm/router.js"

/**
 * OTLP export of traces + metrics + logs over HTTP — the Effect-native
 * `Otlp.layerJson` (no heavy OpenTelemetry SDK), so the published CLI bundle
 * stays light. Spans/metrics emitted by the instrumented core/adapters are
 * serialized and POSTed to `<baseUrl>/v1/{traces,metrics,logs}`. Point it at a
 * local `grafana/otel-lgtm` (default `http://localhost:4318`).
 *
 * Provided at the composition root ONLY when telemetry is enabled — the agent's
 * spans/metrics are no-ops without a tracer/meter, so an un-exported run pays
 * nothing.
 */
export const OtlpTelemetryLive: Layer.Layer<never> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
      Config.withDefault("http://localhost:4318"),
    )
    const serviceName = yield* Config.string("OTEL_SERVICE_NAME").pipe(
      Config.withDefault("efferent"),
    )
    // `service.name` is the prod/eval split (it surfaces as the Prometheus
    // `job` label and is queryable in Tempo); `deployment.environment` mirrors
    // it for dashboards that prefer a stable env tag. A real session is
    // "production"; eval runs set their own resource (`efferent-evals` / "eval").
    const env = yield* Config.string("EFFERENT_OTEL_ENV").pipe(Config.withDefault("production"))
    return Otlp.layerJson({
      baseUrl,
      resource: { serviceName, attributes: { "deployment.environment": env } },
    })
  }).pipe(Effect.orDie),
).pipe(Layer.provide(FetchHttpClientLive))
