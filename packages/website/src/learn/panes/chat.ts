// The chat pane: messages, a composer, suggestion chips. DOM only; the
// orchestrator decides what sending does. Messages go to the chat's queue,
// where the learner's program takes them one at a time, so the composer
// stays open while the agent answers: what you send then waits its turn.
// The rows it draws are the chat model's (chat-model.ts): `render` is given
// them all each time and changes only what changed. A question a tool asks
// before it acts is a row with three buttons, which answer it. In lesson 15
// the last row of each closed turn carries "Branch after turn N", and the row
// of chats above the messages shows each chat of the store, the one shown
// marked.
import type { TurnNumber } from "@xandreed/core/kernel"
import type { Decision } from "@xandreed/sdk/kernel"
import type { ChatEntry } from "../chats.ts"
import { answersTo, NO_TEXT } from "../chat-model.ts"
import type { ChatRow } from "../chat-model.ts"
import { renderMarkdown } from "../markdown.ts"

export interface ChatPane {
  /** An element of the pane's own at the end of the chat: the place a view is drawn in (views.ts). */
  readonly add: (kind: "view", text: string) => HTMLElement
  /**
   * Draw the chat's rows: a new row goes at the end, one already drawn is changed where it is, one that is gone is
   * removed. `branches` (lesson 15) names, by row id, the turn a row closes: it carries "Branch after turn N".
   */
  readonly render: (rows: ReadonlyArray<ChatRow>, branches?: ReadonlyMap<number, TurnNumber>) => void
  /** Draw the row of chats (lesson 15), the one shown marked; an empty row hides it. */
  readonly renderChats: (chats: ReadonlyArray<ChatEntry>, shown: string) => void
  readonly clear: () => void
  readonly setState: (state: { ready: boolean; running: boolean; hint: string }) => void
  readonly focus: () => void
  readonly hasMessages: () => boolean
}

export interface ChatHooks {
  readonly send: (text: string) => void
  readonly sendThree: () => void
  readonly stop: () => void
  readonly newChat: () => void
  readonly decide: (id: string, decision: Decision) => void
  /** "Branch after turn N" was pressed (lesson 15). */
  readonly branch: (turn: TurnNumber) => void
  /** A chat of the row was pressed (lesson 15). */
  readonly choose: (chat: string) => void
}

export const mountChat = (root: HTMLElement, hooks: ChatHooks): ChatPane => {
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
  // Lesson 15's row of chats: only its page has one.
  const chatsBox = root.querySelector<HTMLElement>("[data-chats]")
  const sent: string[] = []
  let recall = -1

  const scrollDown = () => { scroller.scrollTop = scroller.scrollHeight }
  // Follow the newest text while the reader is at the bottom; scrolling up lets go until the next send.
  let following = true
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48
  scroller.addEventListener("scroll", () => { following = nearBottom() }, { passive: true })
  const pending = new Map<HTMLElement, string>()
  let frame = 0
  /** The turn each drawn element closes, for its "Branch after turn N" (lesson 15). */
  const closes = new Map<HTMLElement, TurnNumber>()
  /** The element's button "Branch after turn N", after what it shows, when it closes a turn. */
  const withBranch = (item: HTMLElement) => {
    const turn = closes.get(item)
    if (turn === undefined) return
    const actions = document.createElement("div")
    actions.className = "msg-actions msg-branch"
    const button = document.createElement("button")
    button.type = "button"
    button.className = "btn btn-quiet"
    button.dataset.branchAfter = String(turn)
    button.textContent = `Branch after turn ${turn}`
    button.addEventListener("click", () => hooks.branch(turn))
    actions.append(button)
    item.append(actions)
  }
  const paint = () => {
    frame = 0
    for (const [item, text] of pending) { renderMarkdown(item, text); withBranch(item) }
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

  /**
   * A new element. The messages still waiting are the chat's last, and anything else new goes before them: a
   * waiting message is taken where it stands, so what happened before it is above it.
   */
  const add = (kind: ChatRow["kind"] | "view", text: string, waiting = false) => {
    empty.hidden = true
    const item = document.createElement("li")
    item.className = `pg-msg ${kind}`
    item.textContent = text
    messages.insertBefore(item, waiting ? null : messages.querySelector(":scope > [data-queued]:not([data-dropped])"))
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
  /**
   * A question that waits for the person: what the tool would do, in its words, and the three answers. "Always"
   * names the action, since a standing yes covers the action, not this one detail. A press answers once.
   */
  const drawQuestion = (item: HTMLElement, detail: string, ask: { readonly id: string; readonly action: string }) => {
    const text = document.createElement("p")
    text.className = "ask-detail"
    text.textContent = detail
    const actions = document.createElement("div")
    actions.className = "msg-actions"
    actions.append(...answersTo(ask.action).map(({ decision, label }, index) => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = index === 0 ? "btn btn-primary" : "btn"
      button.dataset.decide = decision._tag
      button.textContent = label
      button.addEventListener("click", () => {
        actions.querySelectorAll("button").forEach((one) => { one.disabled = true })
        hooks.decide(ask.id, decision)
      })
      return button
    }))
    item.replaceChildren(text, actions)
    if (following) scrollDown()
  }
  /** The rows drawn, by the row's id: its element, and what of the row it shows. */
  const drawn = new Map<number, { readonly item: HTMLElement; readonly shown: string }>()
  const draw = (item: HTMLElement, row: ChatRow, closing: TurnNumber | undefined) => {
    if (closing === undefined) closes.delete(item)
    else closes.set(item, closing)
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
    if (row.kind === "ask" && row.ask !== undefined) {
      drawQuestion(item, row.text, row.ask)
      return
    }
    item.textContent = row.text
    if (row.waiting === true) {
      const badge = document.createElement("span")
      badge.className = "msg-queued"
      badge.textContent = row.dropped ?? "waiting"
      item.append(badge)
    }
    withBranch(item)
  }
  const render = (rows: ReadonlyArray<ChatRow>, branches: ReadonlyMap<number, TurnNumber> = new Map()) => {
    const kept = new Set(rows.map((row) => row.id))
    for (const [id, { item }] of drawn) {
      if (kept.has(id)) continue
      pending.delete(item)
      closes.delete(item)
      item.remove()
      drawn.delete(id)
    }
    for (const row of rows) {
      const closing = branches.get(row.id)
      const shown = JSON.stringify([row.kind, row.text, row.live, row.waiting, row.dropped, row.failed, row.seq === undefined, row.ask?.id, row.ask?.action, closing])
      // (Whether a waiting message was taken off the queue changes nothing on screen until it is stored or dropped.)
      const found = drawn.get(row.id)
      if (found?.shown === shown) continue
      const item = found?.item ?? add(row.kind, "", row.waiting === true)
      item.className = `pg-msg ${row.kind}`
      draw(item, row, closing)
      drawn.set(row.id, { item, shown })
    }
  }

  const renderChats = (chats: ReadonlyArray<ChatEntry>, shown: string) => {
    if (chatsBox === null) return
    chatsBox.hidden = chats.length === 0
    chatsBox.replaceChildren(...chats.map((chat) => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "chat-tab"
      button.dataset.chat = chat.id
      button.setAttribute("aria-pressed", String(chat.id === shown))
      button.title = chat.id === shown ? `${chat.label}: the chat shown` : `Show ${chat.label}`
      button.textContent = chat.label
      button.addEventListener("click", () => { if (chat.id !== shown) hooks.choose(chat.id) })
      return button
    }))
  }

  return {
    add,
    render,
    renderChats,
    clear: () => { messages.replaceChildren(); pending.clear(); drawn.clear(); closes.clear(); empty.hidden = false; following = true },
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
