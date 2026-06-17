import { Logger } from "effect"

/**
 * Route Effect logs to **stderr** for the non-interactive modes (print / json /
 * rpc), replacing Effect's default logger — which writes the message to
 * **stdout** (`console.log`) and would corrupt print's final text, json's JSONL,
 * and rpc's framed output. stdout stays the mode's data channel; logs (and any
 * `logWarning`/`logError`) go to stderr.
 *
 * The OTLP logger the telemetry layer adds (`Logger.addScoped`) is a separate
 * entry, so it still ships logs to Loki with their trace context — this only
 * swaps the *console* sink, not the OTLP one.
 */
// NB: `@effect/platform`'s runMain swaps `Logger.defaultLogger` for
// `Logger.prettyLoggerDefault` in the live logger set — so THAT is the instance
// to replace; targeting `defaultLogger` would leave the stdout logger in place
// (it's no longer in the set) and merely *add* ours alongside it.
export const stderrLoggerLayer = Logger.replace(
  Logger.prettyLoggerDefault,
  Logger.prettyLogger({ stderr: true }),
)
