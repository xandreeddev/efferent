// The context inspector: for one model request, the stack of what the model was
// sent, beside the journal that holds everything and what memory sent of it.
import { Option } from "effect"
import { payloadText } from "../payload.ts"
import type { EntryStatus, InspectorModel, RequestView } from "../context-model.ts"

export interface InspectorPane {
  readonly update: (model: InspectorModel) => void
  /** The journal could not be read as requests: say why, in place of the stack. */
  readonly refused: (message: string) => void
  readonly clear: () => void
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A layer is named by the role the model sees it under, not by where it sits. */
const layerName = (layer: { readonly kind: string; readonly role: string }): string =>
  layer.kind === "system" ? "system text"
    : layer.kind === "current" ? `${layer.role} message · latest`
      : `${layer.role} message`
const WHO = { you: "user", agent: "assistant" } as const
const STATUS_TEXT: Record<EntryStatus, string> = {
  current: "latest",
  shown: "sent",
  dropped: "not sent",
  reply: "answer",
}
const STATUS_WHY: Record<EntryStatus, string> = {
  current: "The message this request answers.",
  shown: "The model was sent this message.",
  dropped: "Not sent: memory left it out of this request. The journal still holds it.",
  reply: "What the model answered to this request. It is output, so it is not part of this request's tokens; a later request may send it as an assistant message.",
}

const EMPTY = "Send a message to see what the model is sent, and what the journal keeps."

const oneLine = (text: string, max = 90): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export const mountInspector = (root: HTMLElement): InspectorPane => {
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!
  const label = q("[data-insp-label]")
  const prev = q<HTMLButtonElement>("[data-insp-prev]")
  const next = q<HTMLButtonElement>("[data-insp-next]")
  const meter = q("[data-insp-meter]")
  const fill = q<HTMLElement>("[data-insp-fill]")
  const used = q("[data-insp-used]")
  const prefix = q("[data-insp-prefix]")
  const stack = q("[data-insp-stack]")
  const journal = q("[data-insp-journal]")
  const empty = q("[data-insp-empty]")
  const content = q("[data-insp-content]")
  const kinds = q("[data-insp-kinds]")
  const budgetOut = q("[data-insp-budget]")
  const slider = root.querySelector<HTMLInputElement>('input[data-control="budgetTokens"]')

  let model: InspectorModel | undefined
  let selected = -1

  const showBudget = () => { if (slider) budgetOut.textContent = slider.value }
  slider?.addEventListener("input", showBudget)

  const render = () => {
    const request: RequestView | undefined = model?.requests[selected]
    content.hidden = request === undefined
    empty.hidden = request !== undefined
    prev.disabled = selected <= 0
    next.disabled = !model || selected >= model.requests.length - 1
    label.textContent = request ? `Request ${selected + 1} of ${model!.requests.length} · turn ${request.turn}` : "No requests yet"
    if (!request) { empty.textContent = EMPTY; return }

    // Budget meter
    const budget = request.budgetTokens
    fill.style.width = `${budget > 0 ? Math.min(100, (request.estimatedTokens / budget) * 100) : 0}%`
    meter.dataset.over = String(request.over)
    used.textContent = `${request.estimatedTokens} of ${budget} tokens${request.over ? " (over budget)" : ""}, the system text included`

    // Reusable prefix
    prefix.textContent = Option.match(request.prefix, {
      onNone: () => "First request: nothing earlier to reuse.",
      onSome: (p) => p.layers === 0
        ? "The system text changed, so nothing here matches the previous request: a provider's prompt cache could reuse none of it."
        : `${p.tokens} of ${p.of} tokens (${Math.round((p.tokens / Math.max(1, p.of)) * 100)}%) match the previous request: a provider's prompt cache could reuse them.`,
    })

    // The stack: each layer is as tall as its tokens, within the pane.
    stack.replaceChildren()
    for (const layer of request.layers) {
      const item = el("li", "layer")
      item.dataset.kind = layer.kind
      if (layer.reusable) item.dataset.reusable = ""
      // Taller for more tokens (capped), so the stack reads as a size comparison.
      item.style.minHeight = `${Math.round(34 + Math.min(layer.tokens, 300) * 0.32)}px`
      item.title = layer.text
      const head = el("span", "layer-head")
      head.append(el("span", "layer-name", layerName(layer)), el("span", "layer-tok", `${layer.tokens} tok`))
      item.append(head, el("span", "layer-text", oneLine(layer.text)))
      stack.append(item)
    }
    Option.match(request.reply, {
      onNone: () => {},
      onSome: (reply) => {
        const item = el("li", "layer")
        item.dataset.kind = "reply"
        item.title = reply.text
        const head = el("span", "layer-head")
        head.append(el("span", "layer-name", "assistant message · reply"), el("span", "layer-tok", `${reply.tokens} tok · output`))
        item.append(head, el("span", "layer-text", oneLine(reply.text, 220)))
        stack.append(item)
      },
    })

    // The journal
    journal.replaceChildren()
    let lastTurn = 0
    for (const view of request.entries) {
      if (view.entry.turn !== lastTurn) {
        lastTurn = view.entry.turn
        journal.append(el("li", "turn-head", `turn ${lastTurn}`))
      }
      const item = el("li", "entry")
      item.dataset.status = view.status
      const ended = Option.match(view.ended, { onNone: () => "", onSome: (how) => how === "Failed" ? "turn failed" : "turn stopped" })
      item.title = `${view.entry.text}\n\n${STATUS_WHY[view.status]}${ended ? `\nThis message's turn did not complete (${ended}); the journal keeps the message, and memory may still send it.` : ""}`
      if (ended) item.dataset.failed = ""
      item.append(el("span", "entry-who", WHO[view.entry.role]), el("span", "entry-text", oneLine(view.entry.text, 70)), el("span", "entry-status", `${STATUS_TEXT[view.status]}${ended ? ` · ${ended}` : ""}`))
      journal.append(item)
    }

    // The raw journal events of this turn
    kinds.replaceChildren()
    model!.records.filter((record) => Option.getOrElse(record.turn, () => -1) === request.turn).forEach((record) => {
      const row = el("li", "")
      const details = el("details", "payload")
      details.append(el("summary", "", `${record.seq}  ${record.name}`))
      // Built when opened: most rows are never looked at.
      const shown = Option.match(record.message, { onNone: () => ({ data: record.data }), onSome: (message) => ({ data: record.data, message }) })
      details.addEventListener("toggle", () => { if (details.open && !details.querySelector("pre")) details.append(el("pre", "", payloadText(shown))) })
      row.append(details)
      kinds.append(row)
    })
  }

  prev.addEventListener("click", () => { if (selected > 0) { selected -= 1; render() } })
  next.addEventListener("click", () => { if (model && selected < model.requests.length - 1) { selected += 1; render() } })
  showBudget()
  render()

  return {
    update: (nextModel) => {
      const grew = !model || nextModel.requests.length > model.requests.length
      model = nextModel
      if (grew || selected >= nextModel.requests.length) selected = nextModel.requests.length - 1
      render()
    },
    refused: (message) => {
      model = undefined
      selected = -1
      render()
      empty.textContent = `The journal could not be read as requests: ${message}`
    },
    clear: () => { model = undefined; selected = -1; render() },
  }
}
