/**
 * DOM-id scheme. Identity keys mirror the TUI's keyed cache (`messageKey`
 * positions like `m:p3:a0`, tool-call ids, agent-chosen `render_ui` ids), but
 * htmx resolves `hx-swap-oob` targets with a CSS `#id` selector — a raw `:`
 * in an id throws in `querySelectorAll`. So every key is encoded through an
 * INJECTIVE, CSS-safe mapping: two distinct keys can never collide, and the
 * same key always lands on the same DOM node (that's what makes every WS
 * fragment an idempotent upsert).
 *
 * Encoding: `[A-Za-z0-9-]` pass through; `_` → `__`; any other char →
 * `_XX` (exactly two uppercase hex digits) for code points < 0x100, else
 * `_u` + exactly six uppercase hex digits. Unambiguous to decode (after `_`:
 * another `_`, a lowercase `u` + six hex digits, or exactly two hex digits —
 * and `u` is not a hex digit), therefore injective. Output alphabet is
 * `[A-Za-z0-9_-]` — always a valid CSS identifier tail.
 */

const SAFE = /[A-Za-z0-9-]/

const encodeKey = (key: string): string => {
  let out = ""
  for (const ch of key) {
    if (SAFE.test(ch)) out += ch
    else if (ch === "_") out += "__"
    else {
      const cp = ch.codePointAt(0) ?? 0
      out +=
        cp < 0x100
          ? `_${cp.toString(16).toUpperCase().padStart(2, "0")}`
          : `_u${cp.toString(16).toUpperCase().padStart(6, "0")}`
    }
  }
  return out
}

/** Block/card id prefixes — one per keyed fragment family. */
export type IdPrefix =
  | "blk" // chat rail blocks (messages, tool pills, agents rows, info lines)
  | "ws-file" // workspace file-reference cards (keyed by path)
  | "ws-item" // workspace diff/source cards (keyed by tool-call id)
  | "ui" // generative-UI canvas items (keyed by the agent-chosen id)

/** `domIdForKey("blk", "m:p3:a0")` → `"blk-m_3Ap3_3Aa0"` — stable + CSS-safe. */
export const domIdForKey = (prefix: IdPrefix, key: string): string => `${prefix}-${encodeKey(key)}`

/* Singleton region ids (never encoded — they're already CSS-safe literals). */
export const ID_APP = "ef-app"
export const ID_HEADER = "ef-header"
/** The full-viewport stage wrapper (STATIC — never swapped). */
export const ID_STAGE = "ef-stage"
/** The page tab bar (singleton upsert; renders empty with no pages). */
export const ID_TABS = "ef-tabs"
/** The empty-stage hero (STATIC; CSS-hidden once a page exists). */
export const ID_STAGE_EMPTY = "ef-stage-empty"
/** The generative-UI pages region — one `section.ef-page` per render_ui id. */
export const ID_CANVAS = "ef-canvas"
/** The transcript drawer shell (STATIC left overlay; open state is client-side). */
export const ID_CHAT_DRAWER = "ef-chat-drawer"
/** The chat scroll container (inside the transcript drawer). */
export const ID_CHAT = "ef-chat"
/** The list rail blocks append into (`hx-swap-oob="beforeend:#ef-rail"`). */
export const ID_RAIL = "ef-rail"
/** The references drawer shell (STATIC right overlay). */
export const ID_REFS_DRAWER = "ef-refs-drawer"
/** The workspace card stack (plan excluded — it has its own slot). */
export const ID_WS_ITEMS = "ef-ws-items"
/** The header references-count badge (painted client-side). */
export const ID_REFS_COUNT = "ef-refs-count"
/** The always-present plan slot (singleton upsert; lives in the chat drawer). */
export const ID_PLAN = "ef-plan"
export const ID_APPROVAL = "ef-approval"
export const ID_QUEUE = "ef-queue"
/** The latest-assistant-reply bubble (singleton upsert; dismissible client-side). */
export const ID_REPLY = "ef-reply"
/** The agent activity strip (phase · label · elapsed · interrupt). */
export const ID_ACTIVITY = "ef-activity"
export const ID_COMPOSER = "ef-composer"
/** Connection badge (open/closed), driven by app.js. */
export const ID_CONN = "ef-conn"
/** Hidden self-healing resync form (`ws-send`). */
export const ID_RESYNC_FORM = "ef-resync"
