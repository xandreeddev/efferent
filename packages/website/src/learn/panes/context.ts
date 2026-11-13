// The Loop view: the kernel events of the agent's turns, as the page heard
// them on Core, each with its data. Pieces of one answer share a row.
import { Match } from "effect"
import { payloadText } from "../payload.ts"
import type { LessonEvent } from "../runtime.ts"

export interface ContextPane {
  readonly showView: (view: string) => void
  readonly resetTurn: () => void
  readonly event: (event: LessonEvent, t0: number) => void
  readonly stat: (name: "steps" | "sent" | "answered" | "time", value: string) => void
}

const el = (tag: string, className: string, text: string) => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

/** One line about the event, from its own data. */
const detailOf = (event: LessonEvent): string => Match.valueTags(event, {
  Queued: (queued) => `ticket ${queued.ticket}: "${queued.text.slice(0, 40)}"`,
  TurnStarted: (started) => `turn ${started.turn}`,
  UserMessage: (message) => `turn ${message.turn}: stored`,
  RequestSent: (sent) => `step ${sent.step} · ${sent.messages} message${sent.messages === 1 ? "" : "s"} · ~${sent.estimatedTokens} of ${sent.budgetTokens} tokens`,
  Delta: () => "× 1",
  AssistantMessage: (answer) => `step ${answer.step}: stored`,
  TurnEnded: (ended) => `turn ${ended.turn} · ${ended.outcome._tag}`,
  WindowDropped: (dropped) => `messages through #${dropped.through} leave the window`,
  WindowPressure: (pressure) => `~${pressure.estimatedTokens} of ${pressure.budgetTokens} tokens`,
})

/** Which colour a row's tag takes: the model's answer, the window's own events, or the rest of the loop. */
const kindOf = (event: LessonEvent): string =>
  event._tag === "Delta" || event._tag === "AssistantMessage" ? "assistant" : event._tag.startsWith("Window") ? "window" : "loop"

export const mountContext = (root: HTMLElement): ContextPane => {
  const list = root.querySelector<HTMLElement>("[data-events]")!
  const empty = root.querySelector<HTMLElement>("[data-events-empty]")!
  let deltaRow: { turn: number; pieces: string[]; payload: HTMLElement; detail: HTMLElement } | undefined

  const stat = (name: string, value: string) => {
    const node = root.querySelector(`[data-stat="${name}"]`)
    if (node) node.textContent = value
  }

  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-view-tab]")]
  const showView = (view: string) => {
    tabs.forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.viewTab === view)))
    root.querySelectorAll<HTMLElement>("[data-view]").forEach((panel) => { panel.hidden = panel.dataset.view !== view })
  }
  tabs.forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.viewTab!)))

  return {
    showView,
    resetTurn: () => {
      list.replaceChildren()
      empty.hidden = false
      deltaRow = undefined
      ;["steps", "sent", "answered"].forEach((name) => stat(name, "0"))
      stat("time", "0.0s")
    },
    event: (event, t0) => {
      empty.hidden = true
      if (event._tag === "Delta" && deltaRow?.turn === event.turn) {
        deltaRow.pieces.push(event.text)
        deltaRow.payload.textContent = payloadText({ turn: event.turn, pieces: deltaRow.pieces })
        deltaRow.detail.textContent = `× ${deltaRow.pieces.length}`
        return
      }
      if (event._tag !== "Delta") deltaRow = undefined
      const row = document.createElement("li")
      const details = document.createElement("details")
      const summary = document.createElement("summary")
      const tag = el("span", "tag", event.name)
      tag.dataset.kind = kindOf(event)
      const detail = el("span", "detail", detailOf(event))
      summary.append(tag, detail)
      const { _tag, name, ...data } = event
      const payload = el("pre", "payload", payloadText(event._tag === "Delta" ? { turn: event.turn, pieces: [event.text] } : data))
      details.append(summary, payload)
      row.append(el("span", "t", `${((performance.now() - t0) / 1000).toFixed(2)}s`), details)
      list.append(row)
      if (event._tag === "Delta") deltaRow = { turn: event.turn, pieces: [event.text], payload, detail }
    },
    stat: (name, value) => stat(name, value),
  }
}
