import { dirname } from "node:path"
import { NodeSdk } from "@effect/opentelemetry"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { FileSystem, PlatformLogger } from "@effect/platform"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Layer, Logger } from "effect"

/**
 * The observability edge — two layers every agent main composes:
 *
 * - `TracingLive(serviceName)` exports the spans the kernel already emits
 *   (`engine.run` / `engine.turn` / `providers.generate`) over OTLP HTTP to
 *   the local stack (`bun run obs:up`, grafana on :3000). The exporter reads
 *   the standard `OTEL_EXPORTER_OTLP_ENDPOINT` env itself and defaults to
 *   `http://localhost:4318`; when no collector is listening, batch exports
 *   fail SILENTLY (no diag logger is registered) — always-on costs nothing.
 *
 * - `FileLoggerLive(path)` routes Effect's logger to an append-only logfmt
 *   file. The TUI previously SILENCED all logs (any console write corrupts
 *   the alt screen), which meant a mid-run failure left no trace anywhere —
 *   a session that "just died" was undiagnosable. Now it's on disk.
 */

export const TracingLive = (serviceName: string): Layer.Layer<never> =>
  NodeSdk.layer(() => ({
    resource: { serviceName },
    spanProcessor: [new BatchSpanProcessor(new OTLPTraceExporter())],
    // Effect's Metric registry (the router's llm.* counters + timer) rides
    // the same OTLP endpoint into Prometheus, every 5s.
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 5000,
    }),
  })) as Layer.Layer<never>

export const FileLoggerLive = (path: string): Layer.Layer<never> =>
  Logger.replaceScoped(
    Logger.defaultLogger,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs
        .makeDirectory(dirname(path), { recursive: true })
        .pipe(Effect.orElseSucceed(() => undefined))
      return yield* PlatformLogger.toFile(Logger.logfmtLogger, path, { flag: "a" })
      // An unopenable log file must never fail the boot — fall back to silent
      // (the pre-file behavior), the session is more important than its log.
    }).pipe(Effect.orElseSucceed(() => Logger.none)),
  ).pipe(Layer.provide(BunFileSystem.layer))
