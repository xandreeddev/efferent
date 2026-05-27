import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { HashMap, Logger } from "effect"
import type { LogBuffer } from "./logBuffer.js"

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

const renderAnnotationsHuman = (annos: Record<string, unknown>): string => {
  const entries = Object.entries(annos)
  if (entries.length === 0) return ""
  return " " + entries.map(([k, v]) => `${k}=${String(v)}`).join(" ")
}

/**
 * A Logger that:
 *   - Appends one JSON object per log entry to `path` (newline-delimited,
 *     `jq`-friendly).
 *   - Pushes a compact human-readable line into `buffer` for the TUI's
 *     right pane.
 *
 * Both formats encode the same event; the file is for tooling, the
 * buffer is for the eye. Tail the file (`tail -f ~/.agent/agent.log | jq`)
 * outside the TUI for the same stream.
 */
export const createFileLogger = (path: string, buffer?: LogBuffer) => {
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

    // 1) JSON to file
    try {
      appendFileSync(
        path,
        JSON.stringify({ ts: isoTs, level, msg, ...annos }) + "\n",
      )
    } catch {
      // never throw from the logger
    }

    // 2) Human-readable to buffer
    if (buffer !== undefined) {
      const compactTs = isoTs.slice(11, 19) // HH:MM:SS
      buffer.push(`${compactTs} ${level} ${msg}${renderAnnotationsHuman(annos)}`)
    }
  })
}

/**
 * Layer that ADDS our logger to the current set. (We tried
 * `Logger.replace` — empirically the default still fires alongside it
 * in Effect 3.21, producing duplicate output. `Logger.add` plus a
 * console.log absorber in the TUI driver gives clean one-per-event.)
 */
export const fileLoggerLayer = (path: string, buffer?: LogBuffer) =>
  Logger.add(createFileLogger(path, buffer))
