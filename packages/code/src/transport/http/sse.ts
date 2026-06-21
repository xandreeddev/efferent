import { Schema } from "effect"
import { AgentEvent, type SeqEvent } from "@xandreed/sdk-core"

/**
 * Server-Sent Events codec — the **wire framing** for the daemon's event stream,
 * and the ONLY place the SSE byte format lives. Pure functions (no IO), so both
 * the server (`transport/http/server.ts`) and the client parser
 * (`transport/http/client.ts`) share one definition and it's unit-testable
 * without a socket.
 *
 * Framing (per the plan): an agent event is
 *   `id: <seq>\nevent: agent_event\ndata: <AgentEvent JSON>\n\n`
 * The `id` is the monotonic `seq` so a reconnecting client resumes via
 * `Last-Event-ID`/`?since=`. `resync` tells a client its `since` predates the
 * server's ring (re-fetch `/state`); `: ping` is a keep-alive heartbeat.
 *
 * `data` is always single-line: `JSON.stringify` escapes newlines, so an
 * assistant message with line breaks still serialises to one `data:` line.
 */

export const SSE_EVENT_AGENT = "agent_event"
export const SSE_EVENT_RESYNC = "resync"
export const SSE_EVENT_APPROVAL = "approval_needed"

const decodeAgentEvent = Schema.decodeUnknownOption(AgentEvent)

/** Encode one sequenced agent event as an SSE frame. */
export const encodeSeqEvent = (se: SeqEvent): string =>
  `id: ${se.seq}\nevent: ${SSE_EVENT_AGENT}\ndata: ${JSON.stringify(se.event)}\n\n`

/** A named control frame (e.g. `resync`, `approval_needed`) carrying JSON data. */
export const encodeNamed = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`

/** The `resync` control frame — the client should re-fetch `/state`. */
export const encodeResync = (): string => encodeNamed(SSE_EVENT_RESYNC, {})

/** A keep-alive comment frame (ignored by the parser; keeps the socket warm). */
export const encodeHeartbeat = (): string => `: ping\n\n`

/** One decoded SSE frame: its optional `id`/`event` and joined `data` payload. */
export interface SseFrame {
  readonly id?: string
  readonly event?: string
  readonly data: string
}

/**
 * A stateful SSE parser: feed it raw text chunks (which may split a frame
 * anywhere — mid-line, mid-frame) and it returns the frames completed by that
 * chunk, buffering the rest. Handles CRLF, multi-line `data:`, the single
 * leading-space strip, and `:`-comment heartbeats (skipped). One per connection.
 */
export const makeSseParser = (): {
  readonly push: (chunk: string) => ReadonlyArray<SseFrame>
} => {
  let buffer = ""
  let curId: string | undefined
  let curEvent: string | undefined
  let dataLines: string[] = []
  const reset = (): void => {
    curId = undefined
    curEvent = undefined
    dataLines = []
  }
  return {
    push: (chunk) => {
      buffer += chunk
      const frames: SseFrame[] = []
      let nl: number
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "")
        buffer = buffer.slice(nl + 1)
        if (line === "") {
          // Blank line dispatches the accumulated frame (if any).
          if (curId !== undefined || curEvent !== undefined || dataLines.length > 0) {
            frames.push({
              ...(curId !== undefined ? { id: curId } : {}),
              ...(curEvent !== undefined ? { event: curEvent } : {}),
              data: dataLines.join("\n"),
            })
            reset()
          }
          continue
        }
        if (line.startsWith(":")) continue // comment / heartbeat
        const colon = line.indexOf(":")
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? "" : line.slice(colon + 1)
        if (value.startsWith(" ")) value = value.slice(1)
        if (field === "id") curId = value
        else if (field === "event") curEvent = value
        else if (field === "data") dataLines.push(value)
      }
      return frames
    },
  }
}

/**
 * Decode an agent-event frame into a `SeqEvent`, validating the payload against
 * the `AgentEvent` schema. Returns undefined for control frames (`resync`,
 * `approval_needed`), unparseable JSON, or a payload that doesn't match — the
 * caller handles those by their `event` name.
 */
export const frameToSeqEvent = (frame: SseFrame): SeqEvent | undefined => {
  if (frame.event !== undefined && frame.event !== SSE_EVENT_AGENT) return undefined
  const seq = frame.id !== undefined ? Number(frame.id) : NaN
  if (!Number.isFinite(seq)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(frame.data)
  } catch {
    return undefined
  }
  const decoded = decodeAgentEvent(parsed)
  return decoded._tag === "Some" ? { seq, event: decoded.value } : undefined
}
