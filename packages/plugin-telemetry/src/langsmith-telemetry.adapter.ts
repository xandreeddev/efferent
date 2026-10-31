import { Effect, Layer, Match, Redacted, Tracer } from "effect"
import { harnessError } from "@xandreed/core"
import type { HarnessError } from "@xandreed/core"
import { FetchHttpClient } from "effect/http"
import type { HttpClient } from "effect/http"
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/observability"
import { LANGSMITH_OPTIONS_ERROR } from "./langsmith-telemetry.entity.js"
import type { LangSmithTelemetryOptions } from "./langsmith-telemetry.entity.js"
import { langSmithOptionsOf } from "./langsmith-telemetry.entity.functions.js"
import { langSmithTracer } from "./langsmith-tracer.adapter.js"
import { DEFAULT_SERVICE_NAME } from "./otlp-telemetry.entity.js"

/**
 * Trace-only LangSmith OTLP export over the host's HttpClient. The target is
 * one project or registered agent/environment. tracesUrl is a full signal
 * endpoint, used verbatim. Native Effect AI operations own inference usage;
 * framework wrappers remain chains. Missing custom-model usage stays absent.
 * Capture/retention consent remains the host's existing trace-content policy.
 * The local collector verifies emitted OTLP; live LangSmith ingestion is UNVERIFIED.
 * @public
 */
export const LangSmithTelemetryHttpLive = (options: LangSmithTelemetryOptions): Layer.Layer<OtlpExporter.Flusher, HarnessError, HttpClient.HttpClient> => Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* langSmithOptionsOf(options)
    const destinationHeaders = Match.valueTags(config.target, {
      Project: (target): Readonly<Record<string, string>> => ({ "Langsmith-Project": target.project }),
      Agent: (target): Readonly<Record<string, string>> => ({ "Langsmith-Agent-Id": target.agentId, "Langsmith-Agent-Environment": target.environment }),
    })
    const headers = { ...destinationHeaders, "x-api-key": Redacted.value(config.apiKey) }
    // Validate the actual transport's ByteString/header constraints before an
    // exporter exists. Native errors may repeat a value, so keep no cause.
    yield* Effect.try({ try: () => new Headers(headers), catch: () => harnessError("config.options", LANGSMITH_OPTIONS_ERROR) })
    const tracing = OtlpTracer.make({
      url: config.tracesUrl,
      headers,
      resource: {
        serviceName: config.serviceName ?? config.resourceAttributes?.["service.name"] ?? DEFAULT_SERVICE_NAME,
        ...((config.serviceVersion ?? config.resourceAttributes?.["service.version"]) === undefined ? {} : { serviceVersion: config.serviceVersion ?? config.resourceAttributes?.["service.version"] }),
        ...(config.resourceAttributes === undefined ? {} : { attributes: config.resourceAttributes }),
      },
      ...(config.compression === undefined ? {} : { compression: config.compression }),
      ...(config.exportInterval === undefined ? {} : { exportInterval: config.exportInterval }),
      ...(config.shutdownTimeout === undefined ? {} : { shutdownTimeout: config.shutdownTimeout }),
    }).pipe(Effect.map(langSmithTracer), Layer.effect(Tracer.Tracer))
    return tracing.pipe(
      Layer.provide(config.protocol === "http/json" ? OtlpSerialization.layerJson : OtlpSerialization.layerProtobuf),
      Layer.provideMerge(OtlpExporter.layerFlusher),
    )
  }),
)

/** LangSmithTelemetryHttpLive over the standard fetch client, on Node 24 and Bun. @public */
export const LangSmithTelemetryLive = (options: LangSmithTelemetryOptions): Layer.Layer<OtlpExporter.Flusher, HarnessError> =>
  LangSmithTelemetryHttpLive(options).pipe(Layer.provide(FetchHttpClient.layer))
