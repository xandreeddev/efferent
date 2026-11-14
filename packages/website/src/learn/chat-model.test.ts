// The chat pane's model, fed what real runs of the lessons made the page
// hear: every row drawn from a stored record is the row the journal alone
// gives, the rows of a journal only grow at the end, and what a program
// said without storing it shows once, marked, and is not in the journal's
// rows.
import { afterEach, describe, expect, test } from "bun:test"
import { Option } from "effect"
import { assistantMessage, Seq, ToolCallId, turnEnded, TurnNumber, turnStarted, userMessage } from "@xandreed/core/kernel"
import type { StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import { chatRowsOf, emptyChat, failed, hear, piece, replied, sent, stored, withoutFailure } from "./chat-model.ts"
import type { ChatBoard, ChatRow } from "./chat-model.ts"
import type { Lesson } from "./lesson.ts"
import { compaction } from "./lessons/compaction/lesson.ts"
import { render } from "./lessons/render/lesson.ts"
import { tools } from "./lessons/tools/lesson.ts"
import { yourFirstAgent } from "./lessons/your-first-agent/lesson.ts"
import { loadEcho } from "./models/mock.ts"
import { LessonRuntime } from "./runtime.ts"
import type { Trace } from "./runtime.ts"

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const startersOf = (lesson: Lesson): Record<string, string> => Object.fromEntries(lesson.files.map((file) => [file.id, file.defaultText]))
const applied = (lesson: Lesson, id: string, sources: Record<string, string>) => {
  const experiment = lesson.experiments[id]!
  return { ...sources, [experiment.file]: Option.getOrThrow(experiment.apply(sources[experiment.file] ?? "")) }
}

/** A lesson running on the page's runtime with Echo, and the chat board the page would hold from what it hears. */
const chatOn = async (lesson: Lesson, sources = startersOf(lesson)) => {
  const runtime = await LessonRuntime.create(lesson)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  let board = emptyChat
  runtime.onTrace((trace) => { board = hear(board, trace, runtime.conversation) })
  expect(await runtime.start(sources)).toEqual({ _tag: "Built" })
  const until = (match: (trace: Trace) => boolean, count = 1) => new Promise<void>((resolve) => {
    let seen = 0
    const stop = runtime.onTrace((trace) => { if (match(trace) && ++seen >= count) { stop(); resolve() } })
  })
  /** Send as the page does: a waiting row, then the message into the queue. */
  const send = (text: string) => { board = sent(board, text); runtime.send(text) }
  /** Send one message and wait until its turn has said its reply or its failure. */
  const say = async (text: string) => { const done = until((trace) => trace._tag === "Reply" || trace._tag === "Failed"); send(text); await done }
  return { runtime, board: () => board, change: (to: (now: ChatBoard) => ChatBoard) => { board = to(board) }, send, say, until }
}

/** A row as a test reads it: its kind, whether a record is behind it, and its text. */
const told = (row: ChatRow) => `${row.kind}${row.seq === undefined ? "*" : ""}${row.live === true ? " (live)" : ""}${row.waiting === true ? " (waiting)" : ""}${row.failed === true ? " (failed)" : ""}: ${row.text}`
const storedRows = (rows: ReadonlyArray<ChatRow>) => rows.filter((row) => row.seq !== undefined).map((row) => [row.kind, row.seq, row.turn, row.text] as const)

/** Records as a store would hold them, for the cases no lesson's program makes. */
const journal = (...turns: ReadonlyArray<ReadonlyArray<StoredDraft>>): ReadonlyArray<StoredEvent> => {
  let seq = 0
  return turns.flatMap((drafts, index) => drafts.map((draft): StoredEvent => ({ seq: Seq.make(++seq), at: 0, turn: TurnNumber.make(index + 1), ...draft })))
}
const one = TurnNumber.make(1)

describe("the chat's rows", () => {
  test("a turn with a tool: every row is a stored one, and the journal alone gives the same rows", async () => {
    const { runtime, board, say } = await chatOn(tools)
    await say("What is 12 * 3?")
    expect(board().rows.map(told)).toEqual([
      "user: What is 12 * 3?",
      "agent: Let me work that out.",
      'tool: calculator({"a":12,"op":"*","b":3}) → 36',
      "agent: The tool answered: calculator says 36.",
    ])
    expect(storedRows(board().rows)).toEqual(storedRows(chatRowsOf(await runtime.journal())))
  })

  test("the rows of a journal only grow at the end: those of its first n records start those of n + 1", async () => {
    const { runtime, say } = await chatOn(render)
    await say("Show a table of squares to 3.")
    await say("What is 12 * 3?")
    const events = await runtime.journal()
    expect(events.length).toBeGreaterThan(8)
    for (let n = 0; n < events.length; n++) {
      const [before, after] = [chatRowsOf(events.slice(0, n)), chatRowsOf(events.slice(0, n + 1))]
      expect({ n, rows: after.slice(0, before.length).map(told) }).toEqual({ n, rows: before.map(told) })
    }
  })

  test("three messages sent at once wait, are taken in order by the turn that answers them, and none is left waiting", async () => {
    const { runtime, board, send, until } = await chatOn(tools)
    const done = until((trace) => trace._tag === "Reply")
    for (const text of tools.three) send(text)
    expect(board().rows.filter((row) => row.waiting === true).map((row) => row.text)).toEqual([...tools.three])
    await done
    expect(board().rows.filter((row) => row.waiting === true)).toEqual([])
    expect(board().rows.filter((row) => row.kind === "user").map((row) => row.text)).toEqual([...tools.three])
    expect(storedRows(board().rows)).toEqual(storedRows(chatRowsOf(await runtime.journal())))
  }, 20_000)

  test("a reply the turn never stored shows once, with no record behind it, and the journal's rows do not have it", async () => {
    const { runtime, board, say } = await chatOn(tools, applied(tools, "one-step", startersOf(tools)))
    await say("What is 2 + 2?")
    expect(board().rows.map(told).filter((row) => row.includes("I stopped after"))).toEqual(["agent*: I stopped after 1 steps."])
    const fromJournal = chatRowsOf(await runtime.journal())
    expect(fromJournal.map(told).filter((row) => row.includes("I stopped after"))).toEqual([])
    expect(storedRows(board().rows)).toEqual(storedRows(fromJournal))
  })

  test("a reply the program worded itself shows beside the answer its turn stored", async () => {
    const sources = startersOf(yourFirstAgent)
    const shouting = { ...sources, agent: sources.agent!.replace("chat.reply(text)", "chat.reply(text.toUpperCase())") }
    expect(shouting.agent).not.toBe(sources.agent)
    const { board, say } = await chatOn(yourFirstAgent, shouting)
    await say("hello")
    const answers = board().rows.filter((row) => row.kind === "agent")
    expect(answers.map((row) => row.seq === undefined)).toEqual([false, true])
    expect(answers[1]?.text).toBe(answers[0]?.text.toUpperCase())
  })

  test("a turn that fails shows one error, the journal's, whether or not the program said one too", async () => {
    const sources = applied(compaction, "failing-summarizer", startersOf(compaction))
    const { runtime, board, say } = await chatOn(compaction, sources)
    for (const text of compaction.fill) await say(text)
    for (let press = 0; press < 4 && !board().rows.some((row) => row.kind === "error"); press++) for (const text of compaction.fill) await say(text)
    const errors = board().rows.filter((row) => row.kind === "error")
    expect(errors.length).toBeGreaterThan(0)
    // One error per failed turn, each from the record of that turn's end.
    expect(errors.every((row) => row.seq !== undefined)).toBe(true)
    expect(new Set(errors.map((row) => row.turn)).size).toBe(errors.length)
    expect(errors[0]?.text).toMatch(/^SummaryFailed: /)
    expect(storedRows(board().rows)).toEqual(storedRows(chatRowsOf(await runtime.journal())))
  }, 60_000)

  test("Stop mid-turn: the stopped turn leaves its line, from the record of its end", async () => {
    const { runtime, board, send, say, until } = await chatOn(tools, applied(tools, "slow-calculator", startersOf(tools)))
    const running = until((trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
    send("What is 6 * 7?")
    await running
    await runtime.stop()
    await say("Hello again.")
    const notes = board().rows.filter((row) => row.kind === "note")
    expect(notes.map(told)).toEqual(["note: Turn 1 was stopped. Your message stays in the journal."])
    expect(board().rows.filter((row) => row.live === true)).toEqual([])
    expect(storedRows(board().rows)).toEqual(storedRows(chatRowsOf(await runtime.journal())))
  }, 20_000)
})

describe("the chat's rows, record by record", () => {
  test("an answer being written becomes the row of its record, in place; one that only asks for tools leaves no row", () => {
    const [, asked, answered] = journal([
      turnStarted(one),
      userMessage("Add them."),
      assistantMessage("", { toolCalls: [{ id: ToolCallId.make("c1"), name: "add", params: { a: 1, b: 2 } }] }),
    ])
    const taken = piece(stored(emptyChat, asked!), 1, "")
    expect(taken.rows.map(told)).toEqual(["user: Add them.", "agent* (live): "])
    // The model asked for a tool and wrote nothing: the row it would have written in is gone.
    expect(stored(taken, answered!).rows.map(told)).toEqual(["user: Add them."])
    // The model wrote as it went: the row keeps its place and its identity, and now has a record.
    const written = piece(piece(taken, 1, "It is "), 1, "3.")
    const live = written.rows.at(-1)!
    const final = stored(written, journal([turnStarted(one), userMessage("Add them."), assistantMessage("It is 3.")])[2]!)
    expect(final.rows.map(told)).toEqual(["user: Add them.", "agent: It is 3."])
    expect(final.rows.at(-1)?.id).toBe(live.id)
  })

  test("an answer with no text is a row that says so, and its reply adds nothing", () => {
    const events = journal([turnStarted(one), userMessage("Say nothing."), assistantMessage(""), turnEnded(one, { _tag: "Completed" })])
    const board = replied(events.reduce(stored, emptyChat), 1, "")
    expect(board.rows.map(told)).toEqual(["user: Say nothing.", "agent: "])
  })

  test("a turn that was abandoned, and one that failed, leave a row from the record of their end", () => {
    const two = TurnNumber.make(2)
    const events = journal(
      [turnStarted(one), userMessage("Are you there?"), turnEnded(one, { _tag: "Abandoned" })],
      [turnStarted(two), userMessage("And now?"), turnEnded(two, { _tag: "Failed", reason: "ModelAnswerFailed: the model's stream reported an error" })],
    )
    expect(chatRowsOf(events).map(told)).toEqual([
      "user: Are you there?",
      "note: Turn 1 was left open by a page that closed, and was closed when the next one started. What it stored stays in the journal.",
      "user: And now?",
      "error: ModelAnswerFailed: the model's stream reported an error",
    ])
  })

  test("a failure the program says is shown when the journal holds none for that turn, and not twice when it does", () => {
    const two = TurnNumber.make(2)
    const events = journal([turnStarted(one), userMessage("One."), turnEnded(one, { _tag: "Failed", reason: "Broken: it broke" })], [turnStarted(two), userMessage("Two."), assistantMessage("Fine."), turnEnded(two, { _tag: "Completed" })])
    const board = events.reduce(stored, emptyChat)
    expect(failed(board, 1, "it broke").rows.filter((row) => row.kind === "error").map(told)).toEqual(["error: Broken: it broke"])
    expect(failed(board, 2, "said after the turn").rows.filter((row) => row.kind === "error").map(told)).toEqual(["error: Broken: it broke", "error*: said after the turn"])
    // The page words a lost GPU itself: the journal's row for that turn is taken out.
    expect(withoutFailure(board, 1).rows.filter((row) => row.kind === "error")).toEqual([])
  })
})
