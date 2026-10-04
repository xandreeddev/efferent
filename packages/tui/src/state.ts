import { createSignal } from "solid-js"
import { AssistantDeltaEvent, SessionEvent as SessionEventSchema } from "@xandreed/core"
import type { ConversationId, SessionRecord } from "@xandreed/core"
import { emptyTranscript, projectDelta, projectEvent } from "./projection.js"
import type { EventBody, SessionEvent, SessionLogEvent } from "@xandreed/core"
import type { EventRenderers } from "./projection.js"
import { projectJournal } from "./journal.entity.functions.js"
import type { JournalRenderers } from "./journal.entity.js"
import type { ComposerMode, InspectorRow } from "./presentation.entity.js"
import { failureMessageSummary, groupActivities } from "./presentation.entity.functions.js"
import type { ThemeName } from "./theme.js"
import { Cause, Option, Schema } from "effect"
import { AiError } from "effect/ai"

export const errorMessage = (error: unknown): string => {
  const value = Cause.isCause(error) ? Option.getOrElse(Cause.findErrorOption(error), () => error) : error
  const message = AiError.isAiError(value)
    ? "description" in value.reason && typeof value.reason.description === "string" ? value.reason.description : value.reason.message
    : typeof value === "object" && value !== null && "message" in value ? String(value.message) : String(value)
  return failureMessageSummary(message)
}

export interface MenuRow { readonly label: string; readonly detail: string; readonly select: () => void }
export type Overlay = { readonly onClose?: () => void } & (
  | { readonly kind: "none" }
  | { readonly kind: "menu"; readonly title: string; readonly rows: ReadonlyArray<MenuRow> }
  | { readonly kind: "inspector"; readonly title: string; readonly rows: ReadonlyArray<InspectorRow> }
  | { readonly kind: "text"; readonly title: string; readonly text: string }
  | { readonly kind: "edit"; readonly title: string; readonly value: string; readonly secret?: boolean; readonly save: (value: string) => void }
  | { readonly kind: "approval"; readonly description: string; readonly answer: (allowed: boolean) => void }
)

export const createTuiState = (initial: SessionRecord, theme: ThemeName = "dark", renderers: EventRenderers = {}, journalRenderers: JournalRenderers = {}) => {
  const [session, setSession] = createSignal(initial)
  const [transcript, setTranscript] = createSignal(emptyTranscript)
  // Journal reads and transient batches can arrive in either order. Retain only
  // the latest 128 early text deltas until their durable start is observed.
  const [earlyDeltas, setEarlyDeltas] = createSignal<ReadonlyArray<EventBody>>([])
  const [observedRuns, setObservedRuns] = createSignal<ReadonlySet<string>>(new Set())
  const [overlay, setOverlaySignal] = createSignal<Overlay>({ kind: "none" })
  const [selection, setSelection] = createSignal(0)
  const [query, setQuery] = createSignal("")
  const [filtering, setFiltering] = createSignal(false)
  const [inspecting, setInspecting] = createSignal(false)
  const [notice, setNotice] = createSignal("")
  const [model, setModel] = createSignal("")
  const [mode, setMode] = createSignal<"code" | "plan">("code")
  const [draft, setDraft] = createSignal({ text: "", revision: 0 })
  const [composerText, setComposerText] = createSignal("")
  const [composerMode, setComposerMode] = createSignal<ComposerMode>("insert")
  const [sessionDrafts, setSessionDrafts] = createSignal<Readonly<Record<string, string>>>({})
  const [now, setNow] = createSignal(Date.now())
  const [themeName, setTheme] = createSignal<ThemeName>(theme)
  const [following, setFollowing] = createSignal(true)
  const [windowEnd, setWindowEnd] = createSignal(0)
  const [search, setSearch] = createSignal("")
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const setOverlay = (value: Overlay) => { if (overlay().kind !== "none" && overlay().onClose !== value.onClose) overlay().onClose?.(); setSelection(0); setQuery(""); setFiltering(false); setInspecting(false); setOverlaySignal(value) }
  const restoreDraft = (text: string) => { setComposerText(text); setDraft((previous) => ({ text, revision: previous.revision + 1 })) }
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
    const normalized = events.flatMap((event): ReadonlyArray<EventBody> => event.name !== "native.delta" ? [event] : Option.match(Schema.decodeUnknownOption(AssistantDeltaEvent)(event.data.event), {
      onNone: () => [],
      onSome: (delta) => event.data.sourceSession !== session().id ? [] : [{ name: "assistant.delta", ...(event.runId === undefined ? {} : { runId: event.runId }), data: { channel: delta.channel, step: delta.step, delta: delta.delta, id: delta.id, sourceSession: event.data.sourceSession } }],
    }))
    setTranscript((state) => normalized.reduce(applyDelta, state))
  }
  const applyJournal = (events: ReadonlyArray<SessionLogEvent>, source: ConversationId) => {
    if (source !== session().id) return
    const projected = events.reduce((state, event) => projectJournal(state, event, journalRenderers, renderers, session().id), transcript())
    const lifecycle = events.flatMap((event) => event.kind === "harness.event" && event.session === session().id ? Option.toArray(Schema.decodeUnknownOption(SessionEventSchema)(event.data.event)) : [])
    lifecycle.filter((event) => event.runId && ["run.started", "run.completed", "run.failed", "run.cancelled"].includes(event.name)).forEach((event) => {
      setObservedRuns((runs) => new Set([...runs, event.runId!]))
      if (event.name !== "run.started") setEarlyDeltas((deltas) => deltas.filter((delta) => delta.runId !== event.runId))
    })
    setTranscript(replayEarly(projected))
  }
  return {
    session, transcript, overlay, selection, setSelection, query, setQuery: (text: string) => { setQuery(text); setSelection(0) }, filtering, setFiltering, inspecting, setInspecting,
    notice, setNotice, model, setModel, mode, setMode, themeName, setTheme, now, tick: setNow,
    draft, restoreDraft, composerText, setComposerText, composerMode, setComposerMode,
    following, setFollowing, windowEnd, setWindowEnd, search, setSearch, expanded,
    toggle: (id: string) => setExpanded((all) => all.has(id) ? new Set([...all].filter((key) => key !== id)) : new Set([...all, id])),
    setOverlay,
    setInspector: (value: { readonly title: string; readonly rows: ReadonlyArray<InspectorRow> }) => setOverlay({ kind: "inspector", ...value }),
    inspectTranscript: () => setOverlay({ kind: "inspector", title: "Activity", rows: groupActivities(transcript().blocks).filter((block) => block.kind === "tool" || block.kind === "notice" && (block.category === "edit" || block.category === "check" || block.category === "handoff" || block.status === "failed" || block.status === "cancelled")).slice(-100).reverse().map((block) => ({ id: block.id, label: block.text, detail: block.status, status: block.status, text: block.detail || block.text })) }),
    selectSession: (record: SessionRecord) => {
      setSessionDrafts((drafts) => ({ ...drafts, [session().id]: composerText() })); setSession(record); restoreDraft(sessionDrafts()[record.id] ?? "")
      setComposerMode("insert"); setTranscript(emptyTranscript); setEarlyDeltas([]); setObservedRuns(new Set<string>()); setExpanded(new Set<string>()); setSearch(""); setFollowing(true); setOverlay({ kind: "none" })
    },
    event: (event: SessionEvent) => setTranscript((state) => replayEarly(applyEvent(state, event))),
    events: (events: ReadonlyArray<SessionEvent>) => setTranscript((state) => replayEarly(events.reduce(applyEvent, state))),
    delta: (event: EventBody, source: ConversationId = session().id) => applyDeltas([event], source),
    deltas: (events: ReadonlyArray<EventBody>, source: ConversationId = session().id) => applyDeltas(events, source),
    journal: (events: ReadonlyArray<SessionLogEvent>, source: ConversationId = session().id) => applyJournal(events, source),
  }
}
export type TuiState = ReturnType<typeof createTuiState>

/** Provider and tool output is data, never terminal control sequences. */
export const terminalText = (text: string): string => text
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
