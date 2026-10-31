import { Duration, Effect, Option, Schema } from "effect"
import { harnessError } from "@xandreed/core"
import { LANGSMITH_OPTIONS_ERROR, LANGSMITH_TRACES_URL, LangSmithTelemetryInput } from "./langsmith-telemetry.entity.js"
import type { LangSmithTelemetryOptions } from "./langsmith-telemetry.entity.js"

const invalidOptions = () => harnessError("config.options", LANGSMITH_OPTIONS_ERROR)
const durationValid = (input: Duration.Input | undefined, minimum: number): boolean => input === undefined || Option.exists(Duration.fromInput(input), (value) => {
  const millis = Duration.toMillis(value)
  return Number.isFinite(millis) && millis >= minimum
})

/** Decode without carrying secret-bearing parse input or causes into diagnostics. */
export const langSmithOptionsOf = Effect.fnUntraced(function* (options: LangSmithTelemetryOptions) {
  const parsed = yield* Schema.decodeUnknownEffect(LangSmithTelemetryInput, { onExcessProperty: "error" })(options).pipe(Effect.mapError(invalidOptions))
  if (!durationValid(options.exportInterval, Number.MIN_VALUE) || !durationValid(options.shutdownTimeout, 0)) return yield* Effect.fail(invalidOptions())
  const url = yield* Effect.try({ try: () => new URL(parsed.tracesUrl ?? LANGSMITH_TRACES_URL), catch: invalidOptions })
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" || url.hash !== "") return yield* Effect.fail(invalidOptions())
  const { exportInterval: _exportInterval, shutdownTimeout: _shutdownTimeout, ...config } = parsed
  return {
    ...config,
    tracesUrl: parsed.tracesUrl ?? LANGSMITH_TRACES_URL,
    ...(options.exportInterval === undefined ? {} : { exportInterval: options.exportInterval }),
    ...(options.shutdownTimeout === undefined ? {} : { shutdownTimeout: options.shutdownTimeout }),
  }
})
