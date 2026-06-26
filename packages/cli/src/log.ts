import { homedir } from "node:os"
import { join } from "node:path"
import { Logger } from "effect"
import { createFileLogger } from "./cli/presentation/logger.js"

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

/**
 * The one log file everything appends to — `$EFFERENT_HOME/efferent.log`, else
 * `~/.efferent/efferent.log` (the same path the TUI client uses, so client +
 * daemon + scheduler share a single newline-JSON timeline; appends are atomic).
 * Tail it with `tail -f ~/.efferent/efferent.log | jq`.
 */
export const logFilePath = (): string =>
  join(process.env.EFFERENT_HOME ?? join(homedir(), ".efferent"), "efferent.log")

/**
 * Route Effect logs to the shared log FILE — for the **daemon** modes
 * (`daemon-serve` / `daemon`). A spawned daemon's stderr is discarded
 * (`stdio: "ignore"`), so without this its errors — including the agent runs
 * that happen *inside* the daemon in `efferent` mode — vanish entirely. With it
 * they land in `efferent.log`, never on a console.
 */
export const fileLoggerLayer = Logger.replace(
  Logger.prettyLoggerDefault,
  createFileLogger(logFilePath()),
)
