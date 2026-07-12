import type { UiAgentEvent, UiAgentSession } from "@xandreed/ui-agent"

/** Historical event retained only by the Canvas view reducer. New UI-agent
 * sessions cannot emit it. */
export interface LegacyCanvasEntry {
  readonly id: string
  readonly title: string
  readonly html: string
  readonly mode: "replace" | "append"
  readonly active: boolean
}

export type CanvasEvent = UiAgentEvent | { readonly type: "ui_render"; readonly entry: LegacyCanvasEntry }
export type CanvasSession = UiAgentSession

export { makeUiAgentSession as makeCanvasSession } from "@xandreed/ui-agent"
export type { UiAgentRunServices as CanvasRunServices } from "@xandreed/ui-agent"
