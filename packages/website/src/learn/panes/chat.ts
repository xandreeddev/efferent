// The chat pane: messages, a composer, suggestion chips. DOM only; the
// orchestrator decides what sending does. Messages go to the chat's queue,
// where the learner's program takes them one at a time, so the composer
// stays open while the agent answers: what you send then waits its turn.
// The rows it draws are the chat model's (chat-model.ts): `render` is given
// them all each time and changes only what changed.
import { NO_TEXT } from "../chat-model.ts"
import type { ChatRow } from "../chat-model.ts"
import { renderMarkdown } from "../markdown.ts"

export interface ChatPane {
  /** An element of the pane's own at the end of the chat: the place a view is drawn in (views.ts). */
  readonly add: (kind: "view", text: string) => HTMLElement
  /** Draw the chat's rows: a new row goes at the end, one already drawn is changed where it is, one that is gone is removed. */
  readonly render: (rows: ReadonlyArray<ChatRow>) => void
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

  const add = (kind: ChatRow["kind"] | "view", text: string) => {
    empty.hidden = true
    const item = document.createElement("li")
    item.className = `pg-msg ${kind}`
    item.textContent = text
    messages.append(item)
    if (kind === "user" || following) scrollDown()
    return item
  }
  /** Show `text` (markdown) in an agent message, at the next frame; follows the bottom while the reader has not scrolled up. */
  const setReply = (item: HTMLElement, text: string) => {
    pending.set(item, text)
    if (frame === 0) frame = requestAnimationFrame(paint)
  }
  const flag = (item: HTMLElement, name: string, on: boolean) => {
    if (on) item.dataset[name] = ""
    else delete item.dataset[name]
  }
  /** The rows drawn, by the row's id: its element, and what of the row it shows. */
  const drawn = new Map<number, { readonly item: HTMLElement; readonly shown: string }>()
  const draw = (item: HTMLElement, row: ChatRow) => {
    flag(item, "live", row.live === true)
    flag(item, "queued", row.waiting === true)
    flag(item, "dropped", row.dropped !== undefined)
    flag(item, "failed", row.failed === true)
    // Said by the program or the page, with no record behind it: gone when the chat is drawn from the journal.
    flag(item, "unstored", row.seq === undefined && row.live !== true && row.waiting !== true)
    if (row.kind === "agent") {
      // An answer not yet written is an empty element: the caret shows in it.
      if (row.live === true && row.text.length === 0) { pending.delete(item); item.replaceChildren() }
      else setReply(item, row.text.length > 0 ? row.text : NO_TEXT)
      return
    }
    item.textContent = row.text
    if (row.waiting === true) {
      const badge = document.createElement("span")
      badge.className = "msg-queued"
      badge.textContent = row.dropped ?? "waiting"
      item.append(badge)
    }
  }
  const render = (rows: ReadonlyArray<ChatRow>) => {
    const kept = new Set(rows.map((row) => row.id))
    for (const [id, { item }] of drawn) {
      if (kept.has(id)) continue
      pending.delete(item)
      item.remove()
      drawn.delete(id)
    }
    for (const row of rows) {
      const shown = JSON.stringify([row.kind, row.text, row.live, row.waiting, row.dropped, row.failed, row.seq === undefined])
      const found = drawn.get(row.id)
      if (found?.shown === shown) continue
      const item = found?.item ?? add(row.kind, "")
      item.className = `pg-msg ${row.kind}`
      draw(item, row)
      drawn.set(row.id, { item, shown })
    }
  }

  return {
    add,
    render,
    clear: () => { messages.replaceChildren(); pending.clear(); drawn.clear(); empty.hidden = false; following = true },
    setState: ({ ready, running, hint: text }) => {
      // While the agent answers, more messages may be sent: they wait in the queue.
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
