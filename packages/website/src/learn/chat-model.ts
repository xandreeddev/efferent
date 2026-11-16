// The chat pane's model: the rows the chat shows, as a pure fold. Every row
// drawn from a stored record comes from one step, `stored`, whether the
// record was just announced or is read back from a journal: `chatRowsOf`
// is that step over a whole journal, and its rows only ever grow at the end.
// What a program says and never stores is drawn too, and marked: an answer
// still being written, a message waiting in the queue, a reply that is no
// stored answer ("I stopped after 5 steps."), a failure the program worded
// itself. Those rows have no `seq`, and a chat drawn from the journal alone
// has none of them. A question a tool asks before it acts (lesson 9) is such
// a row too: it is there while it waits, and its answer is a record, drawn
// as a note. Views are not rows: the chat draws them from the same records
// with the kernel's `viewsOf` (views.ts).
import { Match, Option } from "effect"
import { assistantMessageEvent, dataOf, toolResultEvent, turnEndedEvent, userMessageEvent } from "@xandreed/core/kernel"
import type { StoredEvent, TurnNumber, TurnOutcome } from "@xandreed/core/kernel"
import { decidedEvent } from "@xandreed/sdk/kernel"
import type { AttemptData, DecidedData, Decision } from "@xandreed/sdk/kernel"
import type { Trace } from "./runtime.ts"

export interface ChatRow {
  /** The row's identity for whoever draws it: it stays when a row said live becomes the row of its record. */
  readonly id: number
  readonly kind: "user" | "agent" | "tool" | "note" | "error" | "ask"
  readonly text: string
  readonly turn?: number
  /** The place of the record the row is drawn from. A row without one was said, never stored. */
  readonly seq?: number
  /** An answer still being written. */
  readonly live?: true
  /** A message sent and not yet stored by a turn. */
  readonly waiting?: true
  /** A waiting message the program took off the queue: a turn has it, and has not stored it yet. */
  readonly taken?: true
  /** Why a waiting message will never be taken. */
  readonly dropped?: string
  /** A tool's result that is a failure. */
  readonly failed?: true
  /** A question that waits for the person (kind `ask`): the id it is answered by, and the action a standing yes would cover. The row's text is the request's detail. */
  readonly ask?: { readonly id: string; readonly action: string }
}

export interface ChatBoard {
  readonly rows: ReadonlyArray<ChatRow>
  /** The id the next row takes. */
  readonly next: number
  /** The tool calls the model made, by id, as the chat words them. */
  readonly calls: ReadonlyMap<string, string>
  /** The place of the last record taken: a record at or before it was taken already, and is passed over. */
  readonly last: number
  /** When each record taken was stored, by its place: what tells one journal from another that holds the same places. */
  readonly times: ReadonlyArray<number>
  /** The turns whose end was taken, in order: each is closed, and a branch may be cut after it (lesson 15). */
  readonly ended: ReadonlyArray<TurnNumber>
}

export const emptyChat: ChatBoard = { rows: [], next: 1, calls: new Map(), last: 0, times: [], ended: [] }

/** What the chat shows for an answer with no text. */
export const NO_TEXT = "(the model sent no text)"

/**
 * A new row. The messages still waiting are the chat's last rows, and a new row of any other kind goes before
 * them: a waiting message is taken where it stands, so what was stored before it is above it, as in the journal.
 */
const add = (board: ChatBoard, row: Omit<ChatRow, "id">): ChatBoard => {
  const made = { id: board.next, ...row }
  const first = row.waiting === true ? -1 : board.rows.findIndex((one) => one.waiting === true && one.dropped === undefined)
  return { ...board, rows: first < 0 ? [...board.rows, made] : [...board.rows.slice(0, first), made, ...board.rows.slice(first)], next: board.next + 1 }
}
const change = (board: ChatBoard, id: number, to: (row: ChatRow) => Option.Option<ChatRow>): ChatBoard =>
  ({ ...board, rows: board.rows.flatMap((row) => row.id === id ? Option.match(to(row), { onNone: () => [], onSome: (next) => [next] }) : [row]) })
const liveOf = (board: ChatBoard, turn: number) => Option.fromNullishOr(board.rows.find((row) => row.live === true && row.turn === turn))
const settled = ({ live: _live, ...row }: ChatRow): ChatRow => row

/** An answer being written is no longer: gone if it has no text, else kept as it stands, with `suffix` after it. */
const finish = (board: ChatBoard, turn: number, suffix = ""): ChatBoard => Option.match(liveOf(board, turn), {
  onNone: () => board,
  onSome: (row) => change(board, row.id, (found) => found.text.length === 0 ? Option.none() : Option.some(settled({ ...found, text: `${found.text}${suffix}` }))),
})

/**
 * How a turn's failure begins when its answer was cut (lesson 14): the kernel words a failure as its tag, then its
 * message (`reasonOf`), and the tag of a cut answer is `AnswerCut`.
 */
const CUT = "AnswerCut: "

/**
 * Why a turn failed, as the chat says it: the reason its record holds, and for an answer cut after its first words
 * (lesson 14's `AnswerCut`) what that means, before the failure's own words. Read from the record, so a chat drawn
 * again from the journal says the same.
 */
export const failureLine = (reason: string): string =>
  reason.startsWith(CUT) ? `The answer was cut: it failed after its first words were shown, and it is not made again. ${reason.slice(CUT.length)}` : reason

/** What a turn that did not complete leaves in the chat: a line for one that was stopped or abandoned, its reason for one that failed. */
const endRow = (turn: number, outcome: TurnOutcome): Option.Option<Pick<ChatRow, "kind" | "text">> => {
  if (outcome._tag === "Interrupted") return Option.some({ kind: "note", text: `Turn ${turn} was stopped. Your message stays in the journal.` })
  if (outcome._tag === "Abandoned") return Option.some({ kind: "note", text: `Turn ${turn} was left open by a page that closed, and was closed when the next one started. What it stored stays in the journal.` })
  if (outcome._tag === "Failed") return Option.some({ kind: "error", text: failureLine(outcome.reason) })
  return Option.none()
}

/**
 * What the chat's status line says of one attempt of a model call under a plan (lesson 14, `plugin.model.attempt`,
 * said live and never stored): a failed attempt, and a later attempt starting and which step of the plan makes it,
 * each short enough for the line. An attempt that answered says nothing: the turn goes on, and ends. A first attempt says nothing, so a call that
 * answers at once leaves the line as the program set it; the page puts the program's line back when the turn ends.
 */
export const attemptLine = ({ outcome, attempt, step }: AttemptData): Option.Option<string> => {
  if (outcome === "failed") return Option.some(`attempt ${attempt} failed`)
  if (attempt === 1 || outcome !== "started") return Option.none()
  return Option.some(`attempt ${attempt} on step ${step + 1}`)
}

/**
 * What the chat says of an approval's answer (`plugin.approval.decided`, ADR 0012): who said yes or no, and to
 * what. A yes for good names the action it covers; a yes by the host's policy says nobody was asked.
 */
export const decidedLine = ({ action, detail, decision }: DecidedData): string =>
  Match.valueTags(decision, {
    Approved: () => `Approved: ${detail}`,
    ApprovedAlways: () => `Approved for good (${action}): ${detail}`,
    Refused: () => `Refused: ${detail}`,
    Allowed: () => `Allowed by policy: ${detail}`,
  })

/**
 * One stored record of the conversation the chat shows: the one step every stored row comes from. A record is
 * taken once: one read from the journal and then heard announced (a turn closed as the program started) adds
 * nothing the second time.
 */
export const stored = (before: ChatBoard, record: StoredEvent): ChatBoard => {
  if (record.seq <= before.last) return before
  const board = { ...before, last: record.seq, times: [...before.times, record.at] }
  const at = { turn: record.turn, seq: record.seq }
  const message = record.message
  if (record.name === userMessageEvent.name && message?._tag === "User") {
    // A turn that takes several messages stores them one after another: an answer not yet begun is written after the last.
    const open = Option.match(liveOf(board, record.turn), { onNone: () => board, onSome: (row) => row.text.length === 0 ? change(board, row.id, () => Option.none()) : board })
    // The program took the oldest waiting message: its row is now the row of this record.
    const waiting = open.rows.find((row) => row.waiting === true && row.dropped === undefined)
    return waiting === undefined
      ? add(open, { kind: "user", text: message.text, ...at })
      : change(open, waiting.id, ({ waiting: _waiting, taken: _taken, ...row }) => Option.some({ ...row, text: message.text, ...at }))
  }
  if (record.name === assistantMessageEvent.name && message?._tag === "Assistant") {
    const calls = new Map([...board.calls, ...message.toolCalls.map((call) => [call.id, `${call.name}(${JSON.stringify(call.input)})`] as const)])
    const known = { ...board, calls }
    // An answer that only asks for tools has no row: its calls show with their results.
    const shown = message.text.length > 0 || message.toolCalls.length === 0
    // The row to make this record's: the answer being written, or the same text the program already said as its
    // reply, when the reply was heard before the record.
    const said = Option.orElse(liveOf(known, record.turn), () => Option.fromNullishOr(known.rows.find((row) =>
      row.kind === "agent" && row.turn === record.turn && row.seq === undefined && message.toolCalls.length === 0 && row.text.trim() === (message.text.length > 0 ? message.text : NO_TEXT).trim())))
    return Option.match(said, {
      onNone: () => shown ? add(known, { kind: "agent", text: message.text, ...at }) : known,
      onSome: (row) => change(known, row.id, (found) => shown ? Option.some(settled({ ...found, text: message.text, ...at })) : Option.none()),
    })
  }
  if (record.name === toolResultEvent.name && message?._tag === "ToolResult") {
    const text = `${board.calls.get(message.id) ?? message.name} ${message.isFailure ? "failed:" : "→"} ${JSON.stringify(message.result)}`
    return add(board, { kind: "tool", text, ...at, ...(message.isFailure ? { failed: true as const } : {}) })
  }
  // An approval's answer is a record of the turn: a note, drawn from it now and whenever the chat is drawn again.
  const decided = dataOf(decidedEvent, record)
  if (Option.isSome(decided)) return add(board, { kind: "note", text: decidedLine(decided.value), ...at })
  return Option.match(dataOf(turnEndedEvent, record), {
    onNone: () => board,
    onSome: ({ outcome }) => {
      // What was being written when the turn ended was never stored: it stays as it stands, and says so when the turn was stopped.
      const finished = finish(board, record.turn, outcome._tag === "Interrupted" ? "\n\n*(stopped)*" : "")
      // The first end of a turn closes it (a branch is cut there): one more is no other turn.
      const closed = finished.ended.includes(record.turn) ? finished : { ...finished, ended: [...finished.ended, record.turn] }
      // A failure the program said before this record was heard is this turn's: the record's row takes its place.
      const said = outcome._tag === "Failed" ? Option.fromNullishOr(closed.rows.find((row) => row.kind === "error" && row.turn === record.turn && row.seq === undefined)) : Option.none()
      return Option.match(endRow(record.turn, outcome), {
        onNone: () => closed,
        onSome: (row) => Option.match(said, { onNone: () => add(closed, { ...row, ...at }), onSome: (found) => change(closed, found.id, (one) => Option.some({ ...one, ...row, ...at })) }),
      })
    },
  })
}

/** The rows of a journal, read back: what the chat shows of a conversation with nothing said live. */
export const chatRowsOf = (events: ReadonlyArray<StoredEvent>): ReadonlyArray<ChatRow> => events.reduce(stored, emptyChat).rows

/** A message was sent: it waits until a turn takes it. */
export const sent = (board: ChatBoard, text: string): ChatBoard => add(board, { kind: "user", text, waiting: true })

/** The program took `count` messages off the queue: the oldest that wait. */
export const taken = (board: ChatBoard, count: number): ChatBoard => {
  const ids = board.rows.filter((row) => row.waiting === true && row.dropped === undefined && row.taken !== true).slice(0, count).map((row) => row.id)
  return { ...board, rows: board.rows.map((row) => ids.includes(row.id) ? { ...row, taken: true as const } : row) }
}

/** A turn said it is over. A message it took and never stored will not be: it is no conversation, and says so. */
const unstoredTaken = (board: ChatBoard): ChatBoard =>
  ({ ...board, rows: board.rows.map((row) => row.taken === true && row.waiting === true && row.dropped === undefined ? { ...row, dropped: "not stored: its turn ended before it was" } : row) })

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
  const done = unstoredTaken(finish(board, turn))
  const repeats = Option.exists(storedAnswer(done, turn), (row) => row.text.trim() === text.trim())
  return repeats ? done : add(done, { kind: "agent", text: text.length > 0 ? text : NO_TEXT, turn })
}

/** Whether a turn's failure is in the chat already, from the record of its end. */
const failureStored = (board: ChatBoard, turn: number) => board.rows.some((row) => row.kind === "error" && row.turn === turn && row.seq !== undefined)

/** The program said a turn failed. The journal's own word for it shows already when the turn ended failed; else the program's does. */
export const failed = (board: ChatBoard, turn: number, message: string): ChatBoard => {
  const closed = finish(board, turn)
  const done = unstoredTaken(closed)
  // A turn that never stored the message it took opened nothing: the journal holds no end for it, whatever the
  // turn before it left, so the program's word is the only one.
  const neverOpened = done.rows.some((row, index) => row.dropped !== closed.rows[index]?.dropped)
  return !neverOpened && failureStored(done, turn) ? done : add(done, { kind: "error", text: message, ...(neverOpened ? {} : { turn }) })
}

/** A turn's failure, taken out, however it got there: the page says the same thing in words of its own (a lost GPU). */
export const withoutFailure = (board: ChatBoard, turn: number): ChatBoard =>
  ({ ...board, rows: board.rows.filter((row) => !(row.kind === "error" && row.turn === turn)) })

/** How many messages wait for a turn. */
export const waitingCount = (board: ChatBoard): number => board.rows.filter((row) => row.waiting === true && row.dropped === undefined).length

/**
 * A tool asked before it acts: the question is a row while it waits, with the request's detail as its text. It
 * was said, not stored: the answer is what the journal keeps.
 */
export const asking = (board: ChatBoard, id: string, action: string, detail: string): ChatBoard =>
  add(board, { kind: "ask", text: detail, ask: { id, action } })

/** A question no longer waits, answered or dropped with its turn: its row goes. An id no row has changes nothing. */
export const asked = (board: ChatBoard, id: string): ChatBoard =>
  board.rows.some((row) => row.ask?.id === id) ? { ...board, rows: board.rows.filter((row) => row.ask?.id !== id) } : board

/** How many questions wait for the person's answer. */
export const questionsWaiting = (board: ChatBoard): number => board.rows.filter((row) => row.kind === "ask").length

/**
 * The three answers a question's row offers, in the order of its buttons, each with the button's words. "Always"
 * names the action: a standing yes covers the action, not the one detail asked about.
 */
export const answersTo = (action: string): ReadonlyArray<{ readonly decision: Decision; readonly label: string }> => [
  { decision: { _tag: "Approved" }, label: "Approve" },
  { decision: { _tag: "Refused" }, label: "Refuse" },
  { decision: { _tag: "ApprovedAlways" }, label: `Always approve ${action}` },
]

/** What the page's status chip says while a question waits: the turn is open, and waits for the person, not the model. */
export const WAITING_FOR_ANSWER = "waiting for your answer"

/** A line of the page's own: which model answers now, why something did not load. */
export const said = (board: ChatBoard, kind: "note" | "error", text: string): ChatBoard => add(board, { kind, text })

/** The program stopped: nothing more is written, and what waits is not taken. */
export const programEnded = (board: ChatBoard, reason: string): ChatBoard => {
  const closed = board.rows.filter((row) => row.live === true).reduce((now, row) => row.turn === undefined ? now : finish(now, row.turn), board)
  return said(dropWaiting(closed, "not taken: the program stopped"), "error", `${reason[0]?.toUpperCase() ?? ""}${reason.slice(1)} Fix your code, then press Rebuild.`)
}

/**
 * A durable lesson's program named the conversation to show, and here is its journal as the store held it then.
 * The conversation already shown, when that journal goes on from what the chat took, takes the records it has
 * not taken yet (a turn closed as the program started). Any other is drawn from the journal alone, with the
 * messages still waiting after it.
 */
export const showing = (board: ChatBoard, journal: ReadonlyArray<StoredEvent>, sameSession: boolean): ChatBoard =>
  sameSession && continues(board, journal)
    ? journal.reduce(stored, board)
    : board.rows.filter((row) => row.waiting === true && row.dropped === undefined).reduce((now, row) => sent(now, row.text), journal.reduce(stored, emptyChat))

/**
 * Whether a journal goes on from the records the chat took: each of them is there, at its place, stored when it
 * was. A session's journal can be another one under the same id (a store that was changed, or that forgot), and
 * the chat is then drawn from that journal alone.
 */
export const continues = (board: ChatBoard, journal: ReadonlyArray<StoredEvent>): boolean =>
  board.times.every((at, index) => journal[index]?.seq === index + 1 && journal[index]?.at === at)

/**
 * Whether a durable lesson's `Showing` draws the chat from its journal alone: a conversation other than the one
 * shown (another chat picked, a branch, a new one), or the one shown under a journal that does not go on from what
 * the chat took. A chat and its branch share their copied records' places and times, so only the session tells
 * them apart: a switch between the two is always drawn anew. The page and its tests both decide with this.
 */
export const drawsAnew = (board: ChatBoard, shown: string | undefined, trace: { readonly session: string; readonly journal: ReadonlyArray<StoredEvent> }): boolean =>
  trace.session !== shown || !continues(board, trace.journal)

/**
 * Where "Branch after turn N" goes (lesson 15): after the last stored row of each closed turn, by that row's id.
 * A turn still open has none, and neither has a turn that left no row. A row drawn from the journal knows its turn
 * as one drawn live does: both come from the record.
 */
export const branchPoints = (board: ChatBoard): ReadonlyMap<number, TurnNumber> =>
  new Map(board.ended.flatMap((turn) => {
    const last = board.rows.findLast((row) => row.turn === turn && row.seq !== undefined)
    return last === undefined ? [] : [[last.id, turn] as const]
  }))

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
  if (trace._tag === "Taken") return taken(board, trace.count)
  if (trace._tag === "Piece") return piece(board, trace.turn, trace.text)
  if (trace._tag === "Reply") return replied(board, trace.turn, trace.text)
  if (trace._tag === "Failed") return failed(board, trace.turn, trace.message)
  if (trace._tag === "Ended") return programEnded(board, trace.reason)
  if (trace._tag === "Asking") return asking(board, trace.id, trace.action, trace.detail)
  if (trace._tag === "Asked") return asked(board, trace.id)
  return board
}
