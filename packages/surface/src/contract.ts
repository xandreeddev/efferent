/**
 * The browser ↔ server protocol constants agent-authored UI must honour.
 * The sanitizer and `validateUi` both key on these — one source of truth.
 */

/** Every browser-initiated request from agent UI must target this prefix. */
export const ACTION_PREFIX = "/action/"

/** The hidden field naming which page a `/action/ui` post-back belongs to. */
export const UI_ID_FIELD = "ui-id"
