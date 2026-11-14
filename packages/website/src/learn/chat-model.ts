// The chat pane's model: the rows the chat shows, as a pure fold. Every row
// drawn from a stored record comes from one step, `stored`, whether the
// record was just announced or is read back from a journal: `chatRowsOf`
// is that step over a whole journal, and its rows only ever grow at the end.
// What a program says and never stores is drawn too, and marked: an answer
// still being written, a message waiting in the queue, a reply that is no
// stored answer ("I stopped after 5 steps."), a failure the program worded
// itself. Those rows have no `seq`, and a chat drawn from the journal alone
// has none of them. Views are not rows: the chat draws them from the same
// records with the kernel's `viewsOf` (views.ts).
import { Option } from "effect"
import { assistantMessageEvent, dataOf, toolResultEvent, turnEndedEvent, userMessageEvent } from "@xandreed/core/kernel"
import type { StoredEvent, TurnOutcome } from "@xandreed/core/kernel"
import type { Trace } from "./runtime.ts"

export interface ChatRow {
  /** The row's identity for whoever draws it: it stays when a row said live becomes the row of its record. */
  readonly id: number
  readonly kind: "user" | "agent" | "tool" | "note" | "error"
  readonly text: string
  readonly turn?: number
  /** The place of the record the row is drawn from. A row without one was said, never stored. */
  readonly seq?: number
  /** An answer still being written. */
  readonly live?: true
  /** A message sent and not yet taken by a turn. */
  readonly waiting?: true
  /** Why a waiting message will never be taken. */
  readonly dropped?: string
  /** A tool's result that is a failure. */
  readonly failed?: true
}

export interface ChatBoard {
  readonly rows: ReadonlyArray<ChatRow>
  /** The id the next row takes. */
  readonly next: number
  /** The tool calls the model made, by id, as the chat words them. */
  readonly calls: ReadonlyMap<string, string>
}

export const emptyChat: ChatBoard = { rows: [], next: 1, calls: new Map() }

/** What the chat shows for an answer with no text. */
export const NO_TEXT = "(the model sent no text)"

const add = (board: ChatBoard, row: Omit<ChatRow, "id">): ChatBoard => ({ ...board, rows: [...board.rows, { id: board.next, ...row }], next: board.next + 1 })
const change = (board: ChatBoard, id: number, to: (row: ChatRow) => Option.Option<ChatRow>): ChatBoard =>
  ({ ...board, rows: board.rows.flatMap((row) => row.id === id ? Option.match(to(row), { onNone: () => [], onSome: (next) => [next] }) : [row]) })
const liveOf = (board: ChatBoard, turn: number) => Option.fromNullishOr(board.rows.find((row) => row.live === true && row.turn === turn))
const settled = ({ live: _live, ...row }: ChatRow): ChatRow => row

/** An answer being written is no longer: gone if it has no text, else kept as it stands, with `suffix` after it. */
const finish = (board: ChatBoard, turn: number, suffix = ""): ChatBoard => Option.match(liveOf(board, turn), {
  onNone: () => board,
  onSome: (row) => change(board, row.id, (found) => found.text.length === 0 ? Option.none() : Option.some(settled({ ...found, text: `${found.text}${suffix}` }))),
})

/** What a turn that did not complete leaves in the chat: a line for one that was stopped or abandoned, its reason for one that failed. */
const endRow = (turn: number, outcome: TurnOutcome): Option.Option<Pick<ChatRow, "kind" | "text">> => {
  if (outcome._tag === "Interrupted") return Option.some({ kind: "note", text: `Turn ${turn} was stopped. Your message stays in the journal.` })
  if (outcome._tag === "Abandoned") return Option.some({ kind: "note", text: `Turn ${turn} was left open by a page that closed, and was closed when the next one started. What it stored stays in the journal.` })
  if (outcome._tag === "Failed") return Option.some({ kind: "error", text: outcome.reason })
  return Option.none()
}

/** One stored record of the conversation the chat shows: the one step every stored row comes from. */
export const stored = (board: ChatBoard, record: StoredEvent): ChatBoard => {
  const at = { turn: record.turn, seq: record.seq }
  const message = record.message
  if (record.name === userMessageEvent.name && message?._tag === "User") {
    // The program took the oldest waiting message: its row is now the row of this record.
    const waiting = board.rows.find((row) => row.waiting === true && row.dropped === undefined)
    return waiting === undefined
      ? add(board, { kind: "user", text: message.text, ...at })
      : change(board, waiting.id, ({ waiting: _waiting, ...row }) => Option.some({ ...row, text: message.text, ...at }))
  }
  if (record.name === assistantMessageEvent.name && message?._tag === "Assistant") {
    const calls = new Map([...board.calls, ...message.toolCalls.map((call) => [call.id, `${call.name}(${JSON.stringify(call.input)})`] as const)])
    const known = { ...board, calls }
    // An answer that only asks for tools has no row: its calls show with their results.
    const shown = message.text.length > 0 || message.toolCalls.length === 0
    return Option.match(liveOf(known, record.turn), {
      onNone: () => shown ? add(known, { kind: "agent", text: message.text, ...at }) : known,
      onSome: (row) => change(known, row.id, (found) => shown ? Option.some(settled({ ...found, text: message.text, ...at })) : Option.none()),
    })
  }
  if (record.name === toolResultEvent.name && message?._tag === "ToolResult") {
    const text = `${board.calls.get(message.id) ?? message.name} ${message.isFailure ? "failed:" : "→"} ${JSON.stringify(message.result)}`
    return add(board, { kind: "tool", text, ...at, ...(message.isFailure ? { failed: true as const } : {}) })
  }
  return Option.match(dataOf(turnEndedEvent, record), {
    onNone: () => board,
    onSome: ({ outcome }) => {
      // What was being written when the turn ended was never stored: it stays as it stands, and says so when the turn was stopped.
      const closed = finish(board, record.turn, outcome._tag === "Interrupted" ? "\n\n*(stopped)*" : "")
      return Option.match(endRow(record.turn, outcome), { onNone: () => closed, onSome: (row) => add(closed, { ...row, ...at }) })
    },
  })
}

/** The rows of a journal, read back: what the chat shows of a conversation with nothing said live. */
export const chatRowsOf = (events: ReadonlyArray<StoredEvent>): ReadonlyArray<ChatRow> => events.reduce(stored, emptyChat).rows

/** A message was sent: it waits until a turn takes it. */
export const sent = (board: ChatBoard, text: string): ChatBoard => add(board, { kind: "user", text, waiting: true })

/** The messages still waiting will never be taken. */
export const dropWaiting = (board: ChatBoard, why: string): ChatBoard =>
  ({ ...board, rows: board.rows.map((row) => row.waiting === true && row.dropped === undefined ? { ...row, dropped: why } : row) })

/** A piece of an answer as it is written: after the piece before it, in a row of its own turn. An empty piece opens the row. */
export const piece = (board: ChatBoard, turn: number, text: string): ChatBoard => Option.match(liveOf(board, turn), {
  onNone: () => add(board, { kind: "agent", text, turn, live: true }),
  onSome: (row) => change(board, row.id, (found) => Option.some({ ...found, text: `${found.text}${text}` })),
})

/** The last stored row of a turn's conversation, when it is an answer: what a reply of that turn usually repeats. */
const storedAnswer = (board: ChatBoard, turn: number) =>
  Option.filter(Option.fromNullishOr(board.rows.findLast((row) => row.turn === turn && row.seq !== undefined && row.kind !== "note" && row.kind !== "error")), (row) => row.kind === "agent")

/**
 * The program said its reply. Said again, the answer its turn stored last shows nothing more. Any other text
 * (the turn stored no answer last, or the program worded its own) is a row with no record behind it.
 */
export const replied = (board: ChatBoard, turn: number, text: string): ChatBoard => {
  const done = finish(board, turn)
  const repeats = Option.exists(storedAnswer(done, turn), (row) => row.text.trim() === text.trim())
  return repeats ? done : add(done, { kind: "agent", text: text.length > 0 ? text : NO_TEXT, turn })
}

/** Whether a turn's failure is in the chat already, from the record of its end. */
const failureStored = (board: ChatBoard, turn: number) => board.rows.some((row) => row.kind === "error" && row.turn === turn && row.seq !== undefined)

/** The program said a turn failed. The journal's own word for it shows already when the turn ended failed; else the program's does. */
export const failed = (board: ChatBoard, turn: number, message: string): ChatBoard => {
  const done = finish(board, turn)
  return failureStored(done, turn) ? done : add(done, { kind: "error", text: message, turn })
}

/** A turn's failure, taken out, however it got there: the page says the same thing in words of its own (a lost GPU). */
export const withoutFailure = (board: ChatBoard, turn: number): ChatBoard =>
  ({ ...board, rows: board.rows.filter((row) => !(row.kind === "error" && row.turn === turn)) })

/** How many messages wait for a turn. */
export const waitingCount = (board: ChatBoard): number => board.rows.filter((row) => row.waiting === true && row.dropped === undefined).length

/** A line of the page's own: which model answers now, why something did not load. */
export const said = (board: ChatBoard, kind: "note" | "error", text: string): ChatBoard => add(board, { kind, text })

/** The program stopped: nothing more is written, and what waits is not taken. */
export const programEnded = (board: ChatBoard, reason: string): ChatBoard => {
  const closed = board.rows.filter((row) => row.live === true).reduce((now, row) => row.turn === undefined ? now : finish(now, row.turn), board)
  return said(dropWaiting(closed, "not taken: the program stopped"), "error", `${reason[0]?.toUpperCase() ?? ""}${reason.slice(1)} Fix your code, then press Rebuild.`)
}

/** What the page heard, for the conversation the chat shows: the board after it. */
export const hear = (board: ChatBoard, trace: Trace, shown: string): ChatBoard => {
  if (trace._tag === "Event") {
    const event = trace.event
    if (event._tag !== "Stored" || event.session !== shown) return board
    const { session: _session, _tag: _stored, ...record } = event
    const next = stored(board, record)
    // A turn took the message: its answer is being written from here on.
    return record.name === userMessageEvent.name ? piece(next, record.turn, "") : next
  }
  if (trace._tag === "Piece") return piece(board, trace.turn, trace.text)
  if (trace._tag === "Reply") return replied(board, trace.turn, trace.text)
  if (trace._tag === "Failed") return failed(board, trace.turn, trace.message)
  if (trace._tag === "Ended") return programEnded(board, trace.reason)
  return board
}
