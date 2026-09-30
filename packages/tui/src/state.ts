import { createSignal } from "solid-js"
import type { ConversationId, SessionRecord } from "@xandreed/core"
import { emptyTranscript, projectDelta, projectEvent } from "./projection.js"
import type { EventBody, SessionEvent } from "@xandreed/core"
import type { EventRenderers } from "./projection.js"
import type { ThemeName } from "./theme.js"
import { Cause, Option } from "effect"

export const errorMessage = (error: unknown): string => {
  const value = Cause.isCause(error) ? Option.getOrElse(Cause.findErrorOption(error), () => error) : error
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
  // Journal reads and transient batches can arrive in either order. Retain only
  // the latest 128 early text deltas until their durable start is observed.
  const [earlyDeltas, setEarlyDeltas] = createSignal<ReadonlyArray<EventBody>>([])
  const [observedRuns, setObservedRuns] = createSignal<ReadonlySet<string>>(new Set())
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
  const applyEvent = (state: typeof emptyTranscript, event: SessionEvent) => {
    if (event.sessionId !== session().id || event.seq <= state.seq) return state
    const next = projectEvent(state, event, renderers)
    const runId = event.runId
    if (runId && ["run.started", "run.completed", "run.failed", "run.cancelled"].includes(event.name)) {
      setObservedRuns((runs) => new Set([...runs, runId]))
      // A settled run's early text is superseded by its durable blocks.
      if (event.name !== "run.started") setEarlyDeltas((deltas) => deltas.filter((delta) => delta.runId !== runId))
    }
    return next
  }
  /**
   * Replay the running run's early deltas after the whole durable batch, so
   * settlement in that batch remains authoritative. The projection orders
   * turns even when earlier durable blocks arrive in a later batch.
   */
  const replayEarly = (state: typeof emptyTranscript) => {
    const waiting = state.runId === "" ? [] : earlyDeltas().filter((delta) => delta.runId === state.runId)
    if (waiting.length === 0) return state
    setEarlyDeltas((deltas) => deltas.filter((delta) => delta.runId !== state.runId))
    return waiting.reduce(projectDelta, state)
  }
  const applyDelta = (state: typeof emptyTranscript, event: EventBody) => {
    if (event.name !== "assistant.delta" || event.data.channel !== "text" || !event.runId) return state
    if (event.runId === state.runId) return projectDelta(state, event)
    if (!observedRuns().has(event.runId)) setEarlyDeltas((waiting) => [...waiting, event].slice(-128))
    return state
  }
  const applyDeltas = (events: ReadonlyArray<EventBody>, source: ConversationId) => {
    if (source !== session().id) return
    setTranscript((state) => events.reduce(applyDelta, state))
  }
  return {
    session, transcript, overlay, selection, setSelection, notice, setNotice, model, setModel, themeName, setTheme,
    draft, restoreDraft: (text: string) => setDraft((previous) => ({ text, revision: previous.revision + 1 })),
    following, setFollowing, windowEnd, setWindowEnd, search, setSearch, expanded,
    toggle: (id: string) => setExpanded((all) => all.has(id) ? new Set([...all].filter((key) => key !== id)) : new Set([...all, id])),
    setOverlay,
    selectSession: (record: SessionRecord) => { setSession(record); setTranscript(emptyTranscript); setEarlyDeltas([]); setObservedRuns(new Set<string>()); setFollowing(true); setOverlay({ kind: "none" }) },
    event: (event: SessionEvent) => setTranscript((state) => replayEarly(applyEvent(state, event))),
    events: (events: ReadonlyArray<SessionEvent>) => setTranscript((state) => replayEarly(events.reduce(applyEvent, state))),
    delta: (event: EventBody, source: ConversationId = session().id) => applyDeltas([event], source),
    deltas: (events: ReadonlyArray<EventBody>, source: ConversationId = session().id) => applyDeltas(events, source),
  }
}
export type TuiState = ReturnType<typeof createTuiState>

/** Provider and tool output is data, never terminal control sequences. */
export const terminalText = (text: string): string => text
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
