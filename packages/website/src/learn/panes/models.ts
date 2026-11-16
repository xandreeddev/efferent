// The model bar: the current model, its status, and a panel to choose another.
import { Option } from "effect"
import { gatewayChoice } from "../models/gateway.ts"
import { forgetGatewayKey, gatewayKey, listGatewayModels, pickedGatewayModel, pickGatewayModel, saveGatewayKey } from "../models/gateway-key.ts"
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
  /** Show the list again: after a failed load, its card says why. */
  readonly open: () => void
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

  const cardOf = (id: string) => cards.get(id) ?? (id.startsWith("gateway:") ? cards.get("gateway") : undefined)
  /** The gateway's card is in use when the model picked in it is the one loaded: picking another one turns it on. */
  const activeHere = (id: string) => (id === "gateway" ? active === gatewayChoice(pickedGatewayModel()).id : id === active)
  const refresh = () => cards.forEach(({ entry, node, button }, id) => {
    const isActive = activeHere(id)
    node.toggleAttribute("data-active", isActive)
    button.disabled = isActive || busy
    const state = entry.availability.state
    button.textContent = isActive ? "In use" : state === "unavailable" ? "Try anyway" : state === "downloadable" ? "Download and use" : "Use"
  })

  /**
   * The gateway's key and model. The key goes in a password field and is kept for this tab only (gateway-key.ts); the
   * models are the gateway's own list of language models that call tools, read when the search is first used.
   */
  const gatewayForm = (card: HTMLElement): HTMLElement => {
    const form = el("div", { class: "gateway", "data-gateway": "" })
    const keyInput = el("input", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: "Your AI Gateway key", "aria-label": "Your AI Gateway key", "data-gateway-key": "" })
    const save = el("button", { class: "btn btn-quiet", type: "button", "data-gateway-save": "" }, "Save key")
    const forget = el("button", { class: "btn btn-quiet", type: "button", "data-gateway-forget": "" }, "Forget key")
    const keyState = el("p", { class: "msg", "data-gateway-key-state": "" })
    const showKey = () => {
      const has = Option.isSome(gatewayKey())
      keyState.textContent = has
        ? "A key is kept for this tab only: closing the tab, or Forget key, removes it. Code you run in the editor runs in this same page and could read it, so use a key made for this page, with a small spending limit and an expiry."
        : "No key yet. Make one in your Vercel dashboard (AI Gateway, API keys) with a small spending limit and an expiry, and paste it here. Code you run in the editor runs in this same page, and could read the key: use a key made for this page alone."
      forget.hidden = !has
    }
    save.addEventListener("click", () => { saveGatewayKey(keyInput.value); keyInput.value = ""; showKey() })
    forget.addEventListener("click", () => { forgetGatewayKey(); showKey() })
    const search = el("input", { type: "search", placeholder: "Search the gateway's models", "aria-label": "Search the gateway's models", list: "gateway-models", value: pickedGatewayModel(), "data-gateway-model": "" })
    const options = el("datalist", { id: "gateway-models" })
    let listed = false
    search.addEventListener("focus", () => {
      if (listed) return
      listed = true
      listGatewayModels().then((ids) => { options.replaceChildren(...ids.map((id) => el("option", { value: id }))) }).catch((error: unknown) => {
        keyState.textContent = error instanceof Error ? error.message : String(error)
        listed = false
      })
    })
    search.addEventListener("change", () => {
      const model = search.value.trim()
      if (model.length === 0) return
      pickGatewayModel(model)
      const title = card.querySelector("h3")
      if (title) title.textContent = gatewayChoice(model).label
      refresh()
    })
    const keyRow = el("div", { class: "row" })
    keyRow.append(keyInput, save, forget)
    form.append(keyRow, search, options, keyState)
    showKey()
    return form
  }

  return {
    render: (device) => {
      list.replaceChildren()
      cards.clear()
      const entries = catalogue(device)
      const gpuless = entries.filter(({ choice }) => choice.kind === "chrome" || choice.kind === "webllm").every(({ availability }) => availability.state === "unavailable")
      const adapter = device.gpu.adapter ? ` WebGPU: ${device.gpu.adapter}${device.gpu.f16 ? " (half precision)" : ""}.` : ""
      hint.textContent = gpuless
        ? "No GPU model or Chrome's built-in model can run on this browser as it is, so the CPU models are the ones that will run here. Open a card below to see how to fix the others."
        : `Models run on your own machine, and nothing you type leaves your browser, but the gateway's: it sends your messages to a hosted model, with your key. Start small.${adapter}`
      for (const entry of entries) {
        const { choice, availability } = entry
        const node = el("li", { class: "pg-model" })
        const head = el("header")
        head.append(el("h3", {}, choice.label), el("span", { class: "size" }, sizeText(choice, device)))
        node.append(head, el("p", {}, choice.blurb))
        let fix: HTMLDetailsElement | undefined
        if (availability.state === "unavailable") node.append(el("p", { class: "why" }, availability.reason))
        else if (choice.kind === "gateway") node.append(gatewayForm(node))
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
        // The gateway's card loads the model picked in it when the button is pressed, not the one it was drawn with.
        button.addEventListener("click", () => hooks.choose(choice.kind === "gateway" ? gatewayChoice(pickedGatewayModel()) : choice))
        list.append(node)
        cards.set(choice.kind === "gateway" ? "gateway" : choice.id, { entry, node, button, note, ...(fix ? { fix } : {}) })
      }
      refresh()
    },
    setActive: (id) => { active = id; refresh() },
    // Called after every trace the page hears, a streamed piece included: only a change is drawn.
    setBusy: (value) => { if (value === busy) return; busy = value; refresh() },
    progress: (progress) => {
      bar.hidden = progress === undefined
      if (progress === undefined) return
      barFill.style.width = `${Math.round(progress.fraction * 100)}%`
      barText.textContent = progress.text
    },
    note: (id, text) => { const card = cardOf(id); if (card) card.note.textContent = text },
    fail: (id, text) => {
      const card = cardOf(id)
      if (!card) return
      card.note.textContent = text
      if (card.fix) card.fix.open = true
    },
    close: () => setOpen(false),
    open: () => setOpen(true),
  }
}

/** Set the model name shown on the bar. */
export const setModelName = (root: HTMLElement, label: string) => {
  const name = root.querySelector<HTMLElement>("[data-model-name]")
  if (name) name.textContent = label
}
