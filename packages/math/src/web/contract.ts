import { Option } from "effect"
import { parseJsonOption } from "@xandreed/engine"

/**
 * The math shell's browser ↔ server protocol — path constants (shared by the
 * markup and the router; they must match) and the WS client-message parse.
 * Product-owned on the new line; the values match the previous line so a
 * bookmarked session keeps working.
 */

export const WS_PATH = "/ws"
export const ASSET_PREFIX = "/assets"
export const HEALTH_PATH = "/health"
export const SHUTDOWN_PATH = "/shutdown"
export const ACTION_INTERRUPT_PATH = "/action/interrupt"

// --- the typed actions (server grades; no chat) ---
export const ACTION_CHECK_PATH = "/action/check"
export const ACTION_NEXT_PATH = "/action/next"
export const ACTION_REVEAL_PATH = "/action/reveal"
export const ACTION_REPORT_PATH = "/action/report"
export const ACTION_SETUP_PATH = "/action/setup"
export const ACTION_MORE_PATH = "/action/more"
export const ACTION_HARDER_PATH = "/action/harder"
export const ACTION_EASIER_PATH = "/action/easier"
export const ACTION_TOPIC_PATH = "/action/topic"

/** Math answer-form fields: which exercise, and the student's value. */
export const MATH_EX_FIELD = "ex"
export const MATH_VALUE_FIELD = "value"

/** Client→server WS messages. htmx's `ws-send` wraps form fields in a JSON
 *  envelope; we accept that or an explicit `{type: …}` object. The math
 *  shell only sends resync/ping (no chat composer). */
export type ClientMessage = { readonly type: "resync" } | { readonly type: "ping" }

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

/** Parse a raw WS text frame. `None` for garbage (drop silently). */
export const parseClientMessage = (rawText: string): Option.Option<ClientMessage> => {
  // Wire noise drops SILENTLY by design — parseJsonOption, not the warning
  // variant (a garbage frame is not a corrupt config).
  const obj = asRecord(Option.getOrUndefined(parseJsonOption(rawText)))
  if (obj === undefined) return Option.none()
  const type = typeof obj["type"] === "string" ? obj["type"] : undefined
  if (type === "resync") return Option.some({ type: "resync" })
  if (type === "ping") return Option.some({ type: "ping" })
  return Option.none()
}
