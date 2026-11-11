// The Loop view: the turn's events as the agent publishes them, each with its payload.
import { payloadText } from "../payload.ts"
export interface ContextPane {
  readonly showView: (view: string) => void
  readonly resetTurn: () => void
  readonly event: (event: Record<string, unknown>, t0: number) => void
  readonly stat: (name: "steps" | "in" | "out" | "time", value: string) => void
}

const el = (tag: string, className: string, text: string) => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

const detailOf = (e: Record<string, unknown>): string => {
  switch (e._tag) {
    case "step.started": return `step ${e.step} · tools offered: ${(e.activeTools as unknown[]).length}`
    case "context.built": return `~${e.estimatedTokens} tokens of ${e.budgetTokens} budget · ${e.strategy}`
    case "assistant.message": return `finish: ${String(e.finishReason)}`
    case "step.ended": return `step ${e.step} · ${String(e.status)}`
    case "completion.evaluated": return `step ${e.step}`
    case "stream.fallback": return String(e.message)
    default: return ""
  }
}

export const mountContext = (root: HTMLElement): ContextPane => {
  const list = root.querySelector<HTMLElement>("[data-events]")!
  const empty = root.querySelector<HTMLElement>("[data-events-empty]")!
  let deltaRow: { count: number; deltas: string[]; payload: HTMLElement } | undefined

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
      empty.hidden = true
      deltaRow = undefined
      ;["steps", "in", "out"].forEach((name) => stat(name, "0"))
      stat("time", "0.0s")
    },
    event: (e, t0) => {
      const tag = String(e._tag)
      if (tag === "assistant.delta" && deltaRow) {
        deltaRow.count += 1
        deltaRow.deltas.push(String(e.delta))
        deltaRow.payload.textContent = payloadText({ ...e, delta: undefined, deltas: deltaRow.deltas })
        deltaRow.payload.parentElement!.querySelector(".detail")!.textContent = `× ${deltaRow.count}`
        return
      }
      if (tag !== "assistant.delta") deltaRow = undefined
      const row = document.createElement("li")
      const details = document.createElement("details")
      const summary = document.createElement("summary")
      const tagNode = el("span", "tag", tag)
      tagNode.dataset.kind = tag.startsWith("assistant") ? "assistant" : "loop"
      summary.append(tagNode, el("span", "detail", tag === "assistant.delta" ? "× 1" : detailOf(e)))
      const payload = el("pre", "payload", payloadText(e))
      details.append(summary, payload)
      row.append(el("span", "t", `${((performance.now() - t0) / 1000).toFixed(2)}s`), details)
      list.append(row)
      if (tag === "assistant.delta") deltaRow = { count: 1, deltas: [String(e.delta)], payload }
    },
    stat: (name, value) => stat(name, value),
  }
}
