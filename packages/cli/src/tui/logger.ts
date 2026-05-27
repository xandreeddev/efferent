import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { HashMap, Logger } from "effect"
import type { LogBuffer } from "./logBuffer.js"

const stringifyMessage = (message: unknown): string => {
  if (Array.isArray(message)) return message.map((m) => String(m)).join(" ")
  return String(message)
}

const stringifyAnnotations = (
  annotations: HashMap.HashMap<string, unknown>,
): string => {
  if (HashMap.size(annotations) === 0) return ""
  const parts: string[] = []
  for (const [k, v] of annotations) parts.push(`${k}=${String(v)}`)
  return " " + parts.join(" ")
}

const formatLine = (
  opts: Parameters<Parameters<typeof Logger.make>[0]>[0],
): string => {
  const ts = opts.date.toISOString().slice(11, 19) // HH:MM:SS for compactness
  const level = opts.logLevel.label
  const msg = stringifyMessage(opts.message)
  const annos = stringifyAnnotations(opts.annotations)
  return `${ts} ${level} ${msg}${annos}`
}

/**
 * A Logger that appends each log entry as one line to the given file
 * AND (optionally) into an in-memory ring buffer the TUI renders in its
 * right pane. Tail the file (`tail -f ~/.agent/agent.log`) for the same
 * stream outside the TUI.
 */
export const createFileLogger = (path: string, buffer?: LogBuffer) => {
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // best-effort; if mkdir fails we'll fail per-write below
  }
  return Logger.make((opts) => {
    const line = formatLine(opts)
    try {
      appendFileSync(path, line + "\n")
    } catch {
      // dropping a log line is fine; never throw from the logger
    }
    if (buffer !== undefined) buffer.push(line)
  })
}

export const fileLoggerLayer = (path: string, buffer?: LogBuffer) =>
  Logger.replace(Logger.defaultLogger, createFileLogger(path, buffer))
