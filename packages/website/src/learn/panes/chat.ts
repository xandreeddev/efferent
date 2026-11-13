// The chat pane: messages, a composer, suggestion chips. DOM only; the
// orchestrator decides what sending does. Messages go through the agent's
// inbox, so the composer stays open while the agent answers: what you send
// then waits in the queue.
import { renderMarkdown } from "../markdown.ts"

export interface ChatPane {
  readonly add: (kind: "user" | "agent" | "error" | "note", text: string) => HTMLElement
  /** A user message the inbox queued, marked with its ticket until its turn starts. */
  readonly queued: (ticket: number, text: string) => HTMLElement
  /** The queued message's turn started: it is no longer waiting. */
  readonly started: (item: HTMLElement) => void
  /** Show `text` (markdown) in an agent message; follows the bottom while the reader has not scrolled up. */
  readonly setReply: (item: HTMLElement, text: string) => void
  readonly clear: () => void
  readonly setState: (state: { ready: boolean; running: boolean; hint: string }) => void
  readonly focus: () => void
  readonly hasMessages: () => boolean
}

export const mountChat = (root: HTMLElement, hooks: { send: (text: string) => void; sendThree: () => void; stop: () => void; newChat: () => void }): ChatPane => {
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!
  const messages = q("[data-messages]")
  const scroller = q("[data-scroll]")
  const empty = q("[data-empty]")
  const form = q<HTMLFormElement>("[data-compose]")
  const input = q<HTMLTextAreaElement>("[data-input]")
  const send = q<HTMLButtonElement>("[data-send]")
  const stop = q<HTMLButtonElement>("[data-stop]")
  const hint = q("[data-hint]")
  const chips = [...root.querySelectorAll<HTMLButtonElement>("[data-chip-text]")]
  const three = q<HTMLButtonElement>("[data-send-three]")
  const sent: string[] = []
  let recall = -1

  const scrollDown = () => { scroller.scrollTop = scroller.scrollHeight }
  // Follow the newest text while the reader is at the bottom; scrolling up lets go until the next send.
  let following = true
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48
  scroller.addEventListener("scroll", () => { following = nearBottom() }, { passive: true })
  const pending = new Map<HTMLElement, string>()
  let frame = 0
  const paint = () => {
    frame = 0
    for (const [item, text] of pending) renderMarkdown(item, text)
    pending.clear()
    if (following) scrollDown()
  }
  const submit = () => {
    const text = input.value.trim()
    if (!text || send.disabled) return
    sent.push(text)
    recall = -1
    input.value = ""
    following = true // the sent message is shown, and the reply is followed
    hooks.send(text)
  }
  form.addEventListener("submit", (event) => { event.preventDefault(); submit() })
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit() }
    if (event.key === "ArrowUp" && input.value === "" && sent.length > 0) {
      recall = recall < 0 ? sent.length - 1 : Math.max(0, recall - 1)
      input.value = sent[recall] ?? ""
      event.preventDefault()
    }
  })
  stop.addEventListener("click", hooks.stop)
  q("[data-new-chat]").addEventListener("click", hooks.newChat)
  three.addEventListener("click", () => { if (!three.disabled) { following = true; hooks.sendThree() } })
  chips.forEach((chip) => chip.addEventListener("click", () => {
    if (send.disabled) return
    input.value = chip.dataset.chipText ?? ""
    submit()
  }))

  const add = (kind: "user" | "agent" | "error" | "note", text: string) => {
    empty.hidden = true
    const item = document.createElement("li")
    item.className = `pg-msg ${kind}`
    if (kind === "agent") renderMarkdown(item, text)
    else item.textContent = text
    messages.append(item)
    if (kind === "user" || following) scrollDown()
    return item
  }

  return {
    add,
    queued: (ticket, text) => {
      const item = add("user", text)
      item.dataset.queued = String(ticket)
      const badge = document.createElement("span")
      badge.className = "msg-queued"
      badge.textContent = `queued #${ticket}`
      item.append(badge)
      return item
    },
    started: (item) => {
      delete item.dataset.queued
      item.querySelector(".msg-queued")?.remove()
    },
    setReply: (item, text) => {
      pending.set(item, text)
      if (frame === 0) frame = requestAnimationFrame(paint)
    },
    clear: () => { messages.replaceChildren(); pending.clear(); empty.hidden = false; following = true },
    setState: ({ ready, running, hint: text }) => {
      // While the agent answers, more messages may be sent: the inbox queues them.
      input.disabled = !ready
      send.disabled = !ready
      stop.hidden = !running
      chips.forEach((chip) => { chip.disabled = !ready })
      three.disabled = !ready
      hint.textContent = text
    },
    focus: () => input.focus({ preventScroll: true }),
    hasMessages: () => messages.children.length > 0,
  }
}
