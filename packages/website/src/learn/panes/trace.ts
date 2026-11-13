// The Context tab: what happened in each turn, as it happens. A step track
// (turn opened → message stored → context built → prompt sent → answer
// streamed → answer stored → turn closed), then three linked columns: the
// journal, what memory took from it, and the prompt the model received.
// Hovering a row lights the same record everywhere; a step lights what it
// wrote or read. The events log underneath lists everything, in order.
import { Option } from "effect"
import { emptyBoard, LOG_LIMIT, record, turnsOf, viewOf } from "../trace-model.ts"
import type { Board, JournalRow, LogEntry, MemoryRow, PromptRow, StepView, TurnView } from "../trace-model.ts"
import type { Trace } from "../runtime.ts"

export interface TracePane {
  /** Hear one more trace. */
  readonly hear: (trace: Trace) => void
  /** Start over for a new conversation. */
  readonly reset: (session: string) => void
  /** Whether a turn has been seen. */
  readonly hasTurns: () => boolean
}

type Child = Node | string | false | undefined
const el = (tag: string, attrs: Record<string, string | undefined> = {}, ...children: ReadonlyArray<Child | ReadonlyArray<Child>>): HTMLElement => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    if (key === "class") node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children.flat()) {
    if (child === false || child === undefined) continue
    node.append(child)
  }
  return node
}

const roleLabel: Record<string, string> = { system: "system", user: "user", assistant: "assistant" }
const tagChips = (tags: ReadonlyArray<string>) => tags.map((tag) => el("span", { class: "tr-tag", "data-tag": tag }, tag))
const seqAttr = (seq: Option.Option<number>) => Option.match(seq, { onNone: () => undefined, onSome: String })

export const mountTrace = (root: HTMLElement): TracePane => {
  const q = <T extends HTMLElement>(selector: string): T => {
    const found = root.querySelector<T>(selector)
    if (!found) throw new Error(`the Context tab is missing ${selector}`)
    return found
  }
  const turnsBox = q("[data-tr-turns]")
  const follow = q<HTMLInputElement>("[data-tr-follow]")
  const replay = q<HTMLButtonElement>("[data-tr-replay]")
  const empty = q("[data-tr-empty]")
  const body = q("[data-tr-body]")
  const track = q("[data-tr-steps]")
  const stepDetail = q("[data-tr-step-detail]")
  const journalBox = q("[data-tr-journal]")
  const journalHead = q("[data-tr-journal-head]")
  const filters = q("[data-tr-filters]")
  const memoryBox = q("[data-tr-memory]")
  const memoryHead = q("[data-tr-memory-head]")
  const promptBox = q("[data-tr-prompt]")
  const promptHead = q("[data-tr-prompt-head]")
  const logBox = q("[data-tr-log]")
  const logCount = q("[data-tr-log-count]")

  let board: Board = emptyBoard("")
  let t0 = performance.now()
  let selected: Option.Option<number> = Option.none()
  let step: Option.Option<StepView["id"]> = Option.none()
  let filter = "all"
  const openPayloads = new Set<number>()
  let replayTimer: ReturnType<typeof setInterval> | undefined
  let frame = 0
  let logShown = 0

  const shownTurn = (): Option.Option<number> => {
    const turns = turnsOf(board)
    return Option.orElse(Option.filter(selected, (turn) => turns.includes(turn)), () => Option.fromNullishOr(turns.at(-1)))
  }

  // ── turns ────────────────────────────────────────────────────────────────
  const renderTurns = (current: number) => {
    turnsBox.replaceChildren(...turnsOf(board).map((turn) => {
      const view = viewOf(board, turn)
      const state = Option.match(view.closed, { onNone: () => "open", onSome: (text) => (text.startsWith("Completed") ? "done" : "failed") })
      const button = el("button", { type: "button", class: "tr-turn", "data-turn": String(turn), "data-state": state, "aria-pressed": String(turn === current) },
        `Turn ${turn}`, el("span", { class: "tr-turn-mark", "aria-hidden": "true" }, state === "open" ? "…" : state === "done" ? "✓" : "✕"))
      button.addEventListener("click", () => {
        selected = Option.some(turn)
        follow.checked = turn === turnsOf(board).at(-1)
        step = Option.none()
        paint()
      })
      return button
    }))
  }

  // ── step track ──────────────────────────────────────────────────────────
  const renderSteps = (view: TurnView) => {
    track.replaceChildren(...view.steps.map((one, index) => {
      const item = el("li", { class: "tr-step", "data-state": one.state, "data-step": one.id, "aria-current": Option.contains(step, one.id) ? "step" : undefined },
        el("button", { type: "button", title: one.detail },
          el("span", { class: "tr-step-n" }, String(index + 1)),
          el("span", { class: "tr-step-label" }, one.label),
          el("code", { class: "tr-step-code" }, one.code)))
      item.querySelector("button")?.addEventListener("click", () => {
        stopReplay()
        step = Option.contains(step, one.id) ? Option.none() : Option.some(one.id)
        paint()
      })
      return item
    }))
    const lit = Option.flatMap(step, (id) => Option.fromNullishOr(view.steps.find((one) => one.id === id)))
    Option.match(lit, {
      onNone: () => {
        const now = view.steps.find((one) => one.state === "now") ?? view.steps.findLast((one) => one.state === "done" || one.state === "failed")
        stepDetail.replaceChildren(now === undefined ? "" : el("span", {}, el("strong", {}, `${now.label}. `), now.detail))
        root.removeAttribute("data-lit-col")
      },
      onSome: (one) => {
        stepDetail.replaceChildren(el("strong", {}, `${one.label}: `), el("code", {}, one.code), ` ${one.detail}`)
        root.dataset.litCol = one.column
      },
    })
    return Option.match(lit, { onNone: () => new Set<number>(), onSome: (one) => new Set(one.seqs) })
  }

  // ── journal ─────────────────────────────────────────────────────────────
  const useText: Record<JournalRow["use"], string> = {
    "in-context": "in the context",
    "left-out": "left out by memory",
    later: "written after the context",
    "not-conversation": "not conversation: memory skips it",
  }
  const renderJournal = (view: TurnView, lit: ReadonlySet<number>) => {
    const tags = [...new Set(view.journal.flatMap((row) => row.tags))]
    filters.replaceChildren(...["all", ...tags].map((tag) => {
      const button = el("button", { type: "button", class: "tr-filter", "data-tag": tag, "aria-pressed": String(filter === tag) }, tag)
      button.addEventListener("click", () => { filter = tag; paint() })
      return button
    }))
    const rows = view.journal.filter((row) => filter === "all" || row.tags.includes(filter))
    journalHead.textContent = `${view.journal.length} record${view.journal.length === 1 ? "" : "s"}, every turn`
    keepScroll(journalBox, () => journalBox.replaceChildren(...rows.map((row) => {
      const details = el("details", { open: openPayloads.has(row.seq) ? "" : undefined },
        el("summary", {},
          el("span", { class: "tr-seq" }, `#${row.seq}`),
          el("span", { class: "tr-turn-n", title: `written in turn ${row.turn}` }, `t${row.turn}`),
          el("span", { class: "tr-main" },
            el("span", { class: "tr-name" }, el("span", { class: "tr-name-text" }, row.name), tagChips(row.tags)),
            el("span", { class: "tr-text" }, Option.match(row.role, { onNone: () => row.summary, onSome: (role) => `${role}: ${row.summary}` }))),
          el("span", { class: "tr-tags" }, tagChips(row.tags))),
        el("p", { class: "tr-use" }, useText[row.use]),
        el("pre", { class: "tr-payload" }, row.payload))
      details.addEventListener("toggle", () => { if ((details as HTMLDetailsElement).open) openPayloads.add(row.seq); else openPayloads.delete(row.seq) })
      return el("li", { class: "tr-row tr-record", "data-seq": String(row.seq), "data-use": row.use, "data-of-turn": row.ofTurn ? "" : undefined, "data-lit": lit.has(row.seq) ? "" : undefined }, details)
    })))
  }

  // ── memory ──────────────────────────────────────────────────────────────
  const renderMemory = (view: TurnView, lit: ReadonlySet<number>) => {
    Option.match(view.memory, {
      onNone: () => {
        memoryHead.textContent = "not asked yet"
        memoryBox.replaceChildren(el("li", { class: "tr-none" }, "Memory has not been asked for this turn's context yet."))
      },
      onSome: (rows) => {
        const tokens = rows.reduce<number>((sum, row) => sum + row.tokens, 0)
        const leftOut = view.journal.filter((row) => row.use === "left-out")
        memoryHead.textContent = `${rows.length} message${rows.length === 1 ? "" : "s"}, ~${tokens} tok`
        keepScroll(memoryBox, () => memoryBox.replaceChildren(
          ...rows.map((row: MemoryRow) => el("li", { class: "tr-row tr-msg", "data-role": row.role, "data-seq": seqAttr(row.seq), "data-lit": Option.match(row.seq, { onNone: () => undefined, onSome: (seq) => (lit.has(seq) ? "" : undefined) }) },
            el("span", { class: "tr-role" }, roleLabel[row.role] ?? row.role),
            el("span", { class: "tr-text" }, row.text),
            el("span", { class: "tr-from" }, Option.match(row.seq, { onNone: () => "no record", onSome: (seq) => `from #${seq}` }), ` · ${row.tokens} tok`))),
          ...(leftOut.length > 0 ? [el("li", { class: "tr-sep" }, `left out by memory: ${leftOut.length}`)] : []),
          ...leftOut.map((row) => el("li", { class: "tr-row tr-msg", "data-left-out": "", "data-seq": String(row.seq) },
            el("span", { class: "tr-role" }, Option.getOrElse(row.role, () => "")),
            el("span", { class: "tr-text" }, row.summary),
            el("span", { class: "tr-from" }, `#${row.seq} · not sent`))),
        ))
      },
    })
  }

  // ── prompt ──────────────────────────────────────────────────────────────
  const sourceText = (row: PromptRow) =>
    row.source === "code" ? "your code · never stored"
      : row.source === "added" ? "added by your code · never stored"
        : Option.match(row.seq, { onNone: () => "memory", onSome: (seq) => `memory · #${seq}` })
  const renderPrompt = (view: TurnView, lit: ReadonlySet<number>) => {
    Option.match(view.prompt, {
      onNone: () => {
        promptHead.textContent = "not sent yet"
        promptBox.replaceChildren(el("li", { class: "tr-none" }, "No prompt has been sent in this turn yet."))
      },
      onSome: (rows) => {
        const share = view.promptTokens === 0 ? 0 : Math.round((view.reusedTokens / view.promptTokens) * 100)
        promptHead.textContent = `${rows.length} messages, ~${view.promptTokens} tok`
        keepScroll(promptBox, () => promptBox.replaceChildren(
          el("li", { class: "tr-cache", title: "The part of this prompt that is the same as the one before, from the start: what a provider's prompt cache can reuse." },
            el("span", { class: "tr-cache-bar" }, el("i", { style: `width:${share}%` })),
            `${view.reusedTokens} of ${view.promptTokens} tok the same as the prompt before (${share}%)`),
          ...rows.map((row) => el("li", { class: "tr-row tr-msg", "data-role": row.role, "data-source": row.source, "data-reused": row.reused ? "" : undefined, "data-seq": seqAttr(row.seq), "data-lit": Option.match(row.seq, { onNone: () => undefined, onSome: (seq) => (lit.has(seq) ? "" : undefined) }) },
            el("span", { class: "tr-role" }, roleLabel[row.role] ?? row.role),
            el("span", { class: "tr-text" }, row.text),
            el("span", { class: "tr-from" }, `${sourceText(row)} · ${row.tokens} tok`))),
          Option.match(view.usage, {
            onNone: () => el("li", { class: "tr-usage" }, "Token counts are estimates: a quarter of the characters. This model reports no usage of its own."),
            onSome: (usage) => el("li", { class: "tr-usage" }, `The provider counted ${usage.inputTokens ?? "?"} tokens in, ${usage.outputTokens ?? "?"} out${usage.cachedInputTokens === undefined ? "" : `, ${usage.cachedInputTokens} read from its cache`}.`),
          }),
        ))
      },
    })
  }

  // ── events log ──────────────────────────────────────────────────────────
  const entryOf = (entry: LogEntry) => el("li", { class: "tr-log-entry", "data-kind": entry.kind, "data-seq": seqAttr(entry.seq) },
    el("details", {},
      el("summary", {},
        el("span", { class: "tr-log-t" }, `${(entry.at / 1000).toFixed(2)}s`),
        el("span", { class: "tr-log-kind" }, entry.kind),
        el("span", { class: "tr-log-title" }, entry.turn > 0 ? `t${entry.turn} · ${entry.title}` : entry.title),
        el("span", { class: "tr-tags" }, tagChips(entry.tags))),
      el("pre", { class: "tr-payload" }, entry.detail)))
  const renderLog = () => {
    const fresh = board.logged - logShown
    if (fresh <= 0) return
    const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40
    logBox.append(...board.log.slice(-Math.min(fresh, LOG_LIMIT)).map(entryOf))
    while (logBox.children.length > LOG_LIMIT) logBox.firstElementChild?.remove()
    logShown = board.logged
    logCount.textContent = String(board.logged)
    if (atBottom) logBox.scrollTop = logBox.scrollHeight
  }

  const keepScroll = (box: HTMLElement, draw: () => void) => {
    const top = box.scrollTop
    draw()
    box.scrollTop = top
  }

  const paint = () => {
    frame = 0
    const current = shownTurn()
    empty.hidden = Option.isSome(current)
    body.hidden = Option.isNone(current)
    renderLog()
    if (Option.isNone(current)) { turnsBox.replaceChildren(); return }
    const view = viewOf(board, current.value)
    renderTurns(current.value)
    const lit = renderSteps(view)
    renderJournal(view, lit)
    renderMemory(view, lit)
    renderPrompt(view, lit)
    if (lit.size > 0) root.querySelector('[data-lit=""]')?.scrollIntoView({ block: "nearest" })
  }
  const paintSoon = () => { if (frame === 0) frame = requestAnimationFrame(paint) }

  // Hover a row: the same record lights in every column.
  root.addEventListener("pointerover", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-seq]")
    root.querySelectorAll("[data-linked]").forEach((one) => one.removeAttribute("data-linked"))
    if (!row?.dataset.seq) return
    root.querySelectorAll(`[data-seq="${row.dataset.seq}"]`).forEach((one) => one.setAttribute("data-linked", ""))
  })
  root.addEventListener("pointerleave", () => root.querySelectorAll("[data-linked]").forEach((one) => one.removeAttribute("data-linked")))

  // Replay: walk the turn's steps one by one.
  const stopReplay = () => {
    clearInterval(replayTimer)
    replayTimer = undefined
    replay.textContent = "▶ Replay"
  }
  replay.addEventListener("click", () => {
    if (replayTimer !== undefined) { stopReplay(); return }
    const current = shownTurn()
    if (Option.isNone(current)) return
    const ids = viewOf(board, current.value).steps.map((one) => one.id)
    let index = 0
    step = Option.some(ids[0]!)
    replay.textContent = "■ Stop"
    paint()
    replayTimer = setInterval(() => {
      index++
      if (index >= ids.length) { stopReplay(); step = Option.none(); paint(); return }
      step = Option.some(ids[index]!)
      paint()
    }, 1100)
  })
  follow.addEventListener("change", () => { if (follow.checked) { selected = Option.none(); paintSoon() } })

  return {
    hear: (trace) => {
      const before = turnsOf(board).length
      board = record(board, trace, performance.now() - t0)
      // A new turn: follow it, unless the reader picked one to look at.
      if (follow.checked && turnsOf(board).length !== before) { selected = Option.none(); step = Option.none() }
      paintSoon()
    },
    reset: (session) => {
      stopReplay()
      board = emptyBoard(session)
      t0 = performance.now()
      selected = Option.none()
      step = Option.none()
      openPayloads.clear()
      logShown = 0
      logBox.replaceChildren()
      logCount.textContent = "0"
      paintSoon()
    },
    hasTurns: () => turnsOf(board).length > 0,
  }
}
