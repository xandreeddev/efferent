// The model bar: the current model, its status, and a panel to choose another.
import { catalogue, sizeText } from "../models/registry.ts"
import type { Device, Entry } from "../models/registry.ts"
import type { LoadProgress, ModelChoice } from "../models/types.ts"

export interface ModelsPane {
  readonly render: (device: Device) => void
  readonly setActive: (id: string | undefined) => void
  readonly setBusy: (busy: boolean) => void
  readonly progress: (progress: LoadProgress | undefined) => void
  readonly note: (id: string, text: string) => void
  /** A load failed: show why, and open the card's "how to make it work". */
  readonly fail: (id: string, text: string) => void
  readonly close: () => void
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, text?: string) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) node.setAttribute(key, value)
  if (text !== undefined) node.textContent = text
  return node
}

export const mountModels = (root: HTMLElement, hooks: { choose: (choice: ModelChoice) => void }): ModelsPane => {
  const toggle = root.querySelector<HTMLButtonElement>("[data-model-toggle]")!
  const panel = root.querySelector<HTMLElement>("[data-model-panel]")!
  const list = root.querySelector<HTMLElement>("[data-models]")!
  const hint = root.querySelector<HTMLElement>("[data-model-hint]")!
  const bar = root.querySelector<HTMLElement>("[data-model-progress]")!
  const barFill = bar.querySelector<HTMLElement>("i")!
  const barText = root.querySelector<HTMLElement>("[data-model-progress-text]")!
  const name = root.querySelector<HTMLElement>("[data-model-name]")!
  const cards = new Map<string, { entry: Entry; node: HTMLElement; button: HTMLButtonElement; note: HTMLElement; fix?: HTMLDetailsElement }>()
  let active: string | undefined
  let busy = false

  const setOpen = (open: boolean) => {
    panel.hidden = !open
    toggle.setAttribute("aria-expanded", String(open))
  }
  toggle.addEventListener("click", () => setOpen(panel.hidden))
  document.addEventListener("click", (event) => { if (!panel.hidden && !root.contains(event.target as Node)) setOpen(false) })
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") setOpen(false) })

  const refresh = () => cards.forEach(({ entry, node, button }, id) => {
    const isActive = id === active
    node.toggleAttribute("data-active", isActive)
    button.disabled = isActive || busy
    const state = entry.availability.state
    button.textContent = isActive ? "In use" : state === "unavailable" ? "Try anyway" : state === "downloadable" ? "Download and use" : "Use"
  })

  return {
    render: (device) => {
      list.replaceChildren()
      cards.clear()
      const entries = catalogue(device)
      const gpuless = entries.filter(({ choice }) => choice.kind === "chrome" || choice.kind === "webllm").every(({ availability }) => availability.state === "unavailable")
      const adapter = device.gpu.adapter ? ` WebGPU: ${device.gpu.adapter}${device.gpu.f16 ? " (half precision)" : ""}.` : ""
      hint.textContent = gpuless
        ? "No GPU model or Chrome's built-in model can run on this browser as it is, so the CPU models are the ones that will run here. Open a card below to see how to fix the others."
        : `Models run on your own machine. Nothing you type leaves your browser. Start small.${adapter}`
      for (const entry of entries) {
        const { choice, availability } = entry
        const node = el("li", { class: "pg-model" })
        const head = el("header")
        head.append(el("h3", {}, choice.label), el("span", { class: "size" }, sizeText(choice, device)))
        node.append(head, el("p", {}, choice.blurb))
        let fix: HTMLDetailsElement | undefined
        if (availability.state === "unavailable") node.append(el("p", { class: "why" }, availability.reason))
        else if (choice.kind !== "echo") node.append(el("p", { class: "ok" }, "Works on this device."))
        if (entry.fix && availability.state === "unavailable") {
          fix = el("details", { class: "fix" })
          fix.append(el("summary", {}, "How to make it work"), el("p", {}, entry.fix))
          node.append(fix)
        }
        const button = el("button", { class: "btn", type: "button" })
        const note = el("p", { class: "msg" })
        const row = el("div", { class: "row" })
        row.append(button)
        node.append(row, note)
        button.addEventListener("click", () => hooks.choose(choice))
        list.append(node)
        cards.set(choice.id, { entry, node, button, note, ...(fix ? { fix } : {}) })
      }
      refresh()
    },
    setActive: (id) => { active = id; refresh() },
    setBusy: (value) => { busy = value; refresh() },
    progress: (progress) => {
      bar.hidden = progress === undefined
      if (progress === undefined) return
      barFill.style.width = `${Math.round(progress.fraction * 100)}%`
      barText.textContent = progress.text
    },
    note: (id, text) => { const card = cards.get(id); if (card) card.note.textContent = text },
    fail: (id, text) => {
      const card = cards.get(id)
      if (!card) return
      card.note.textContent = text
      if (card.fix) card.fix.open = true
    },
    close: () => setOpen(false),
  }
}

/** Set the model name shown on the bar. */
export const setModelName = (root: HTMLElement, label: string) => {
  const name = root.querySelector<HTMLElement>("[data-model-name]")
  if (name) name.textContent = label
}
