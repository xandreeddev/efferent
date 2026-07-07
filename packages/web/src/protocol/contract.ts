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

// --- the standalone math shell's typed actions (server grades; no chat) ----
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
