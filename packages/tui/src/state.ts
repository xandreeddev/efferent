import { createSignal } from "solid-js"
import type { SessionRecord } from "@xandreed/core"
import { emptyTranscript, projectDelta, projectEvent } from "./projection.js"
import type { EventBody, SessionEvent } from "@xandreed/core"
import type { EventRenderers } from "./projection.js"
import type { ThemeName } from "./theme.js"
import { Cause, Option } from "effect"

export const errorMessage = (error: unknown): string => {
  const value = Cause.isCause(error) ? Option.getOrElse(Cause.failureOption(error), () => error) : error
  const message = typeof value === "object" && value !== null && "message" in value ? String(value.message) : String(value)
  return message.split("\n")[0]!.replace(/^(?:(?:HarnessError|UnknownError|Error):\s*)+/, "")
}

export interface MenuRow { readonly label: string; readonly detail: string; readonly select: () => void }
export type Overlay = { readonly onClose?: () => void } & (
  | { readonly kind: "none" }
  | { readonly kind: "menu"; readonly title: string; readonly rows: ReadonlyArray<MenuRow> }
  | { readonly kind: "text"; readonly title: string; readonly text: string }
  | { readonly kind: "edit"; readonly title: string; readonly value: string; readonly secret?: boolean; readonly save: (value: string) => void }
  | { readonly kind: "approval"; readonly description: string; readonly answer: (allowed: boolean) => void }
)

export const createTuiState = (initial: SessionRecord, theme: ThemeName = "dark", renderers: EventRenderers = {}) => {
  const [session, setSession] = createSignal(initial)
  const [transcript, setTranscript] = createSignal(emptyTranscript)
  const [overlay, setOverlaySignal] = createSignal<Overlay>({ kind: "none" })
  const [selection, setSelection] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  const [model, setModel] = createSignal("")
  const [draft, setDraft] = createSignal({ text: "", revision: 0 })
  const [themeName, setTheme] = createSignal<ThemeName>(theme)
  const [following, setFollowing] = createSignal(true)
  const [windowEnd, setWindowEnd] = createSignal(0)
  const [search, setSearch] = createSignal("")
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const setOverlay = (value: Overlay) => { if (value.kind === "none") overlay().onClose?.(); setSelection(0); setOverlaySignal(value) }
  return {
    session, transcript, overlay, selection, setSelection, notice, setNotice, model, setModel, themeName, setTheme,
    draft, restoreDraft: (text: string) => setDraft((previous) => ({ text, revision: previous.revision + 1 })),
    following, setFollowing, windowEnd, setWindowEnd, search, setSearch, expanded,
    toggle: (id: string) => setExpanded((all) => all.has(id) ? new Set([...all].filter((key) => key !== id)) : new Set([...all, id])),
    setOverlay,
    selectSession: (record: SessionRecord) => { setSession(record); setTranscript(emptyTranscript); setFollowing(true); setOverlay({ kind: "none" }) },
    event: (event: SessionEvent) => setTranscript((state) => projectEvent(state, event, renderers)),
    events: (events: ReadonlyArray<SessionEvent>) => setTranscript((state) => events.reduce((current, event) => projectEvent(current, event, renderers), state)),
    delta: (event: EventBody) => setTranscript((state) => projectDelta(state, event)),
    deltas: (events: ReadonlyArray<EventBody>) => setTranscript((state) => events.reduce(projectDelta, state)),
  }
}
export type TuiState = ReturnType<typeof createTuiState>

/** Provider and tool output is data, never terminal control sequences. */
export const terminalText = (text: string): string => text
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
