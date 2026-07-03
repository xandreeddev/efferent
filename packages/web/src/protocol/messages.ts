import { UI_ID_FIELD } from "./contract.js"

/**
 * Client→server messages over the WebSocket. htmx's `ws-send` wraps form
 * fields in a JSON envelope with a `HEADERS` object; we accept that envelope
 * or an explicit `{type: …}` object.
 */
export type ClientMessage =
  | {
      readonly type: "chat"
      readonly prompt: string
      /** The page (render_ui id) the user is viewing — the composer's hidden
       *  field; becomes the `[viewing:<id>]` context marker on the prompt. */
      readonly page?: string
    }
  | { readonly type: "resync" }
  | { readonly type: "ping" }

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** Parse a raw WS text frame. Returns undefined for garbage (drop silently). */
export const parseClientMessage = (rawText: string): ClientMessage | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return undefined
  }
  const obj = asRecord(parsed)
  if (obj === undefined) return undefined
  const type = typeof obj["type"] === "string" ? obj["type"] : undefined
  if (type === "resync") return { type: "resync" }
  if (type === "ping") return { type: "ping" }
  const prompt = typeof obj["prompt"] === "string" ? obj["prompt"].trim() : ""
  const page = typeof obj["page"] === "string" ? obj["page"].trim() : ""
  if ((type === "chat" || type === undefined) && prompt !== "") {
    return { type: "chat", prompt, ...(page !== "" ? { page } : {}) }
  }
  return undefined
}

/** Prefix a prompt with the viewing-context marker (`[viewing:<page>] …`) —
 *  the same convention family as `[ui:<id>]` post-backs. */
export const withViewingContext = (prompt: string, page: string | undefined): string =>
  page !== undefined && page !== "" ? `[viewing:${page}] ${prompt}` : prompt

/** A generative-UI form submission (POST /action/ui). */
export interface UiActionPayload {
  /** The emitting card's id — the reserved `ui-id` hidden field, if present. */
  readonly id?: string
  /** Every submitted field except htmx bookkeeping. */
  readonly fields: Readonly<Record<string, string>>
}

const SKIP_FIELDS = new Set(["HEADERS"])

/** Normalize a form body (URLSearchParams or a plain record) to a payload. */
export const parseActionPayload = (
  form: URLSearchParams | Readonly<Record<string, string>>,
): UiActionPayload => {
  const fields: Record<string, string> = {}
  const entries: Iterable<[string, string]> =
    form instanceof URLSearchParams ? form.entries() : Object.entries(form)
  for (const [k, v] of entries) {
    if (!SKIP_FIELDS.has(k)) fields[k] = v
  }
  const id = fields[UI_ID_FIELD]
  return id !== undefined && id !== "" ? { id, fields } : { fields }
}

/** Render a UI action as the user message the agent reads. */
export const formatUiActionMessage = (payload: UiActionPayload): string => {
  const rest = Object.entries(payload.fields)
    .filter(([k]) => k !== UI_ID_FIELD)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ")
  return `[ui${payload.id !== undefined ? `:${payload.id}` : ""}] ${rest}`.trim()
}
