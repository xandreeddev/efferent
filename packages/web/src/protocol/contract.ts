/**
 * Path constants shared by the shell markup, the sanitizer's URL rules, and
 * the cli driver's routes. Web owns them; the driver's router must match.
 */
export const WS_PATH = "/ws"
export const SEND_PATH = "/send"
/** All browser POSTs live under /action/* — the sanitizer's URL-prefix rule. */
export const ACTION_PREFIX = "/action/"
export const ACTION_UI_PATH = "/action/ui"
export const ACTION_APPROVE_PATH = "/action/approve"
export const ACTION_INTERRUPT_PATH = "/action/interrupt"
export const ASSET_PREFIX = "/assets"
export const HEALTH_PATH = "/health"
export const SHUTDOWN_PATH = "/shutdown"

/** The reserved generative-UI form field naming the emitting card. */
export const UI_ID_FIELD = "ui-id"
