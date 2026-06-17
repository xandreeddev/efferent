import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { HashMap, Logger } from "effect"

const stringifyMessage = (message: unknown): string => {
  if (Array.isArray(message)) return message.map((m) => String(m)).join(" ")
  return String(message)
}

const collectAnnotations = (
  annotations: HashMap.HashMap<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of annotations) out[k] = v
  return out
}

/**
 * A Logger that appends one JSON object per log entry to `path`
 * (newline-delimited, `jq`-friendly). Tail with
 * `tail -f ~/.efferent/efferent.log | jq` from another terminal.
 */
export const createFileLogger = (path: string) => {
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // best-effort; per-write append will fail if it really can't write
  }
  return Logger.make((opts) => {
    const isoTs = opts.date.toISOString()
    const level = opts.logLevel.label
    const msg = stringifyMessage(opts.message)
    const annos = collectAnnotations(opts.annotations)

    try {
      appendFileSync(
        path,
        JSON.stringify({ ts: isoTs, level, msg, ...annos }) + "\n",
      )
    } catch {
      // never throw from the logger
    }
  })
}

/**
 * Layer that REPLACES the console logger with our file logger, so `Effect.log*`
 * never writes to stdout and corrupts the OpenTUI alt-buffer. We target
 * `Logger.prettyLoggerDefault` — the instance `@effect/platform`'s runMain puts
 * in the live set (it removes `Logger.defaultLogger` first) — so the stdout sink
 * is genuinely gone. The OTLP logger the telemetry layer adds
 * (`Logger.addScoped`) is a separate entry, so logs still ship to Loki with
 * their trace context; this only swaps the console sink.
 */
export const fileLoggerLayer = (path: string) =>
  Logger.replace(Logger.prettyLoggerDefault, createFileLogger(path))
