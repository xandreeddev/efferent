// The chat pane's model, fed what real runs of the lessons made the page
// hear: every row drawn from a stored record is the row the journal alone
// gives, the rows of a journal only grow at the end, and what a program
// said without storing it shows once, marked, and is not in the journal's
// rows.
import { afterEach, describe, expect, test } from "bun:test"
import { Option } from "effect"
import { assistantMessage, Seq, SessionId, stored as draftOf, ToolCallId, toolResult, turnEnded, TurnNumber, turnStarted, userMessage } from "@xandreed/core/kernel"
import type { StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import { APPROVAL_REFUSED, decidedEvent, TaskId, taskReport } from "@xandreed/sdk/kernel"
import type { Decision } from "@xandreed/sdk/kernel"
import { answersTo, asked, asking, attemptLine, branchPoints, chatRowsOf, drawsAnew, decidedLine, dropWaiting, emptyChat, failed, failureLine, hear, piece, questionsWaiting, replied, reportLine, sent, stored, taken, WAITING_FOR_ANSWER, waitingCount, withoutFailure } from "./chat-model.ts"
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

  test("a message sent while a slow tool runs is drawn where the journal has it: after the tool's result, steered into the turn or in a turn of its own", async () => {
    const slow = applied(tools, "slow-calculator", startersOf(tools))
    for (const [sources, turns] of [[slow, 1], [applied(tools, "no-steering", slow), 2]] as const) {
      const { runtime, board, send, until } = await chatOn(tools, sources)
      const running = until((trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
      const done = until((trace) => trace._tag === "Reply", turns)
      send("What is 6 * 7?")
      await running
      send("Also, what is 10 / 4?")
      // It waits below what the turn has drawn so far.
      expect(board().rows.at(-1)).toMatchObject({ kind: "user", text: "Also, what is 10 / 4?", waiting: true })
      await done
      const kinds = board().rows.map((row) => `${row.kind}${row.seq === undefined ? "*" : ""}`)
      const second = board().rows.findIndex((row) => row.text === "Also, what is 10 / 4?")
      expect({ turns, kinds: kinds.slice(0, second + 1) }).toEqual({ turns, kinds: turns === 1 ? ["user", "agent", "tool", "user"] : ["user", "agent", "tool", "agent", "user"] })
      // Row for row, in the order of the journal: a chat drawn from it again is the same chat.
      expect({ turns, rows: storedRows(board().rows) }).toEqual({ turns, rows: storedRows(chatRowsOf(await runtime.journal())) })
      expect(board().rows.filter((row) => row.seq === undefined)).toEqual([])
      await runtime.dispose()
    }
  }, 30_000)

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
  test("an answer cut after its first words (lesson 14): the words written stay, and the failure's row says the answer was cut, from the record, live and drawn again alike", () => {
    const reason = "AnswerCut: echo.streamText: it broke"
    const records = journal([turnStarted(one), userMessage("Hello."), turnEnded(one, { _tag: "Failed", reason })])
    const line = "The answer was cut: it failed after its first words were shown, and it is not made again. echo.streamText: it broke"
    expect(failureLine(reason)).toBe(line)
    // Any other failure is said as its record says it.
    expect(failureLine("Broken: it broke")).toBe("Broken: it broke")
    const writing = piece(piece(records.slice(0, 2).reduce(stored, emptyChat), 1, ""), 1, "Half ")
    const said = failed(writing, 1, "echo.streamText: it broke")
    expect(said.rows.map(told)).toEqual(["user: Hello.", "agent*: Half ", "error*: echo.streamText: it broke"])
    expect(stored(said, records[2]!).rows.map(told)).toEqual(["user: Hello.", "agent*: Half ", `error: ${line}`])
    // Drawn from the journal alone: the same failure's row, and no word, since none was stored.
    expect(chatRowsOf(records).map(told)).toEqual(["user: Hello.", `error: ${line}`])
  })

  test("the status line of a call under a plan (lesson 14): a failed attempt, a later one starting and answering; a first attempt says nothing", () => {
    expect(attemptLine({ outcome: "started", attempt: 1, step: 0 })).toEqual(Option.none())
    expect(attemptLine({ outcome: "succeeded", attempt: 1, step: 0 })).toEqual(Option.none())
    expect(attemptLine({ outcome: "failed", attempt: 1, step: 0, reason: "busy" })).toEqual(Option.some("attempt 1 failed"))
    expect(attemptLine({ outcome: "started", attempt: 2, step: 1 })).toEqual(Option.some("attempt 2 on step 2"))
    expect(attemptLine({ outcome: "succeeded", attempt: 2, step: 1 })).toEqual(Option.none())
  })

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

  test("a turn stopped while its answer was being written keeps what was written, marked, and then the turn's line", () => {
    const [started, asked, , ended] = journal([turnStarted(one), userMessage("Tell me about loops."), assistantMessage("never stored"), turnEnded(one, { _tag: "Interrupted" })])
    const writing = piece(piece(piece([started!, asked!].reduce(stored, emptyChat), 1, ""), 1, "A loop is"), 1, " a turn that")
    expect(writing.rows.map(told)).toEqual(["user: Tell me about loops.", "agent* (live): A loop is a turn that"])
    expect(stored(writing, ended!).rows.map(told)).toEqual([
      "user: Tell me about loops.",
      "agent*: A loop is a turn that\n\n*(stopped)*",
      "note: Turn 1 was stopped. Your message stays in the journal.",
    ])
    // Nothing was written yet: the empty row goes, and the line stays.
    expect(stored(piece([started!, asked!].reduce(stored, emptyChat), 1, ""), ended!).rows.map(told)).toEqual(["user: Tell me about loops.", "note: Turn 1 was stopped. Your message stays in the journal."])
  })

  test("what the program says is heard before the record it repeats: the record takes the row, and nothing shows twice", () => {
    const answered = journal([turnStarted(one), userMessage("Hello."), assistantMessage("Hello!"), turnEnded(one, { _tag: "Completed" })])
    const early = replied(answered.slice(0, 2).reduce(stored, emptyChat), 1, "Hello!")
    expect(early.rows.map(told)).toEqual(["user: Hello.", "agent*: Hello!"])
    expect(answered.slice(2).reduce(stored, early).rows.map(told)).toEqual(["user: Hello.", "agent: Hello!"])
    const broken = journal([turnStarted(one), userMessage("Hello."), turnEnded(one, { _tag: "Failed", reason: "Broken: it broke" })])
    const said = failed(broken.slice(0, 2).reduce(stored, emptyChat), 1, "it broke")
    expect(said.rows.map(told)).toEqual(["user: Hello.", "error*: it broke"])
    expect(broken.slice(2).reduce(stored, said).rows.map(told)).toEqual(["user: Hello.", "error: Broken: it broke"])
  })

  test("messages that wait stay the chat's last rows, and are dropped where they stand", () => {
    const [started, asked, answered] = journal([turnStarted(one), userMessage("One."), assistantMessage("Fine.")])
    const waiting = sent(sent(piece([started!, asked!].reduce(stored, emptyChat), 1, "Fi"), "Two."), "Three.")
    expect(waiting.rows.map(told)).toEqual(["user: One.", "agent* (live): Fi", "user* (waiting): Two.", "user* (waiting): Three."])
    const after = stored(waiting, answered!)
    expect(after.rows.map(told)).toEqual(["user: One.", "agent: Fine.", "user* (waiting): Two.", "user* (waiting): Three."])
    // Dropped, they are no longer waiting for a turn: what comes next goes after them.
    const dropped = sent(dropWaiting(after, "dropped by Stop"), "Four.")
    expect(dropped.rows.map((row) => [row.text, row.dropped ?? ""])).toEqual([["One.", ""], ["Fine.", ""], ["Two.", "dropped by Stop"], ["Three.", "dropped by Stop"], ["Four.", ""]])
    expect(waitingCount(dropped)).toBe(1)
  })

  test("a message a turn took and never stored is no longer waiting once the turn says it failed: it says so, and the failure follows it", () => {
    const one = TurnNumber.make(1)
    const before = journal([turnStarted(one), userMessage("One."), turnEnded(one, { _tag: "Failed", reason: "Broken: it broke" })]).reduce(stored, emptyChat)
    // The next message is taken off the queue, and its turn is refused before it stores anything: no record names it.
    const refused = failed(taken(sent(before, "Two."), 1), 1, "the session is busy")
    expect(refused.rows.map((row) => `${told(row)}${row.dropped === undefined ? "" : ` [${row.dropped}]`}`)).toEqual([
      "user: One.",
      "error: Broken: it broke",
      "user* (waiting): Two. [not stored: its turn ended before it was]",
      "error*: the session is busy",
    ])
    expect(waitingCount(refused)).toBe(0)
    // What is sent next is a message of its own: the one that was dropped is not taken for it.
    const next = journal([turnStarted(one), userMessage("One."), turnEnded(one, { _tag: "Failed", reason: "Broken: it broke" })], [turnStarted(TurnNumber.make(2)), userMessage("Three.")])[4]!
    expect(stored(taken(sent(refused, "Three."), 1), next).rows.map((row) => row.text).slice(-3)).toEqual(["Two.", "the session is busy", "Three."])
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

  test("an approval's answer is a note drawn from its record, worded by who decided: a person once, a person for good, a refusal, a policy", () => {
    const request = { action: "notes.forget", detail: "Delete all 2 notes." }
    const decided = (decision: Decision): StoredDraft => draftOf(decidedEvent, { ...request, decision })
    expect((["Approved", "ApprovedAlways", "Refused", "Allowed"] as const).map((tag) => decidedLine({ ...request, decision: { _tag: tag } }))).toEqual([
      "Approved: Delete all 2 notes.",
      "Approved for good (notes.forget): Delete all 2 notes.",
      "Refused: Delete all 2 notes.",
      "Allowed by policy: Delete all 2 notes.",
    ])
    // In a turn: the note is the row of its record, between the model's call and the call's result, where the journal has it.
    const call = { id: ToolCallId.make("c1"), name: "forget", params: {} }
    const events = journal([
      turnStarted(one), userMessage("Forget my notes."), assistantMessage("", { toolCalls: [call] }),
      decided({ _tag: "Refused" }), toolResult(call, APPROVAL_REFUSED, true), assistantMessage("I did not."), turnEnded(one, { _tag: "Completed" }),
    ])
    expect(chatRowsOf(events).map(told)).toEqual([
      "user: Forget my notes.",
      "note: Refused: Delete all 2 notes.",
      `tool (failed): forget({}) failed: ${JSON.stringify(APPROVAL_REFUSED)}`,
      "agent: I did not.",
    ])
    expect(chatRowsOf(events)[1]).toMatchObject({ kind: "note", seq: 4, turn: 1 })
    // Announced live, the same record gives the same row; heard a second time, nothing more.
    const live = events.reduce(stored, emptyChat)
    expect(events.reduce(stored, live).rows).toEqual(live.rows)
  })

  test("a question is a row with no record while it waits, before the messages that wait, and goes when it is answered or dropped", () => {
    const [started, message, called] = journal([turnStarted(one), userMessage("Forget my notes."), assistantMessage("Let me see.", { toolCalls: [{ id: ToolCallId.make("c1"), name: "forget", params: {} }] })])
    const open = sent([started!, message!, called!].reduce(stored, emptyChat), "And then?")
    const waiting = asking(open, "question-1", "notes.forget", "Delete all 2 notes.")
    expect(waiting.rows.map(told)).toEqual(["user: Forget my notes.", "agent: Let me see.", "ask*: Delete all 2 notes.", "user* (waiting): And then?"])
    expect(waiting.rows[2]).toMatchObject({ kind: "ask", text: "Delete all 2 notes.", ask: { id: "question-1", action: "notes.forget" } })
    expect(waiting.rows[2]?.seq).toBeUndefined()
    expect([questionsWaiting(open), questionsWaiting(waiting)]).toEqual([0, 1])
    // The page hears it as two traces: the question put, and the question taken back.
    expect(hear(open, { _tag: "Asking", id: "question-1", action: "notes.forget", detail: "Delete all 2 notes." }, "any").rows.map(told)).toEqual(waiting.rows.map(told))
    const gone = hear(waiting, { _tag: "Asked", id: "question-1" }, "any")
    expect(gone.rows.map(told)).toEqual(open.rows.map(told))
    expect(questionsWaiting(gone)).toBe(0)
    // An id no row has changes nothing, and two questions go one by one.
    expect(asked(waiting, "question-2")).toBe(waiting)
    const two = asking(waiting, "question-2", "tool.forget", "Call forget with {}.")
    expect(questionsWaiting(two)).toBe(2)
    expect(asked(two, "question-1").rows.filter((row) => row.kind === "ask").map((row) => row.ask?.id)).toEqual(["question-2"])
    // Its three buttons, in order: yes for this once, no, and yes for good, which names the action it covers.
    expect(answersTo("notes.forget")).toEqual([
      { decision: { _tag: "Approved" }, label: "Approve" },
      { decision: { _tag: "Refused" }, label: "Refuse" },
      { decision: { _tag: "ApprovedAlways" }, label: "Always approve notes.forget" },
    ])
    // What the page's chip says while one waits.
    expect(WAITING_FOR_ANSWER).toBe("waiting for your answer")
    // A chat drawn from the journal alone has no question: it was said, never stored.
    expect(chatRowsOf([started!, message!, called!]).some((row) => row.kind === "ask")).toBe(false)
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

  test("lesson 15: Branch after turn N is at the last stored row of each closed turn, a turn's first end alone counts, and an open turn has none", () => {
    const two = TurnNumber.make(2)
    const events = journal(
      [turnStarted(one), userMessage("Hello."), assistantMessage("Hello!"), turnEnded(one, { _tag: "Completed" }), turnEnded(one, { _tag: "Completed" })],
      [turnStarted(two), userMessage("Again."), turnEnded(two, { _tag: "Interrupted" })],
      [turnStarted(TurnNumber.make(3)), userMessage("Open.")],
    )
    const board = events.reduce(stored, emptyChat)
    expect(board.ended).toEqual([one, two])
    expect([...branchPoints(board)].map(([id, turn]) => [board.rows.find((row) => row.id === id)?.text, Number(turn)])).toEqual([
      ["Hello!", 1], ["Turn 2 was stopped. Your message stays in the journal.", 2],
    ])
  })

  test("lesson 15: a Showing of another session is drawn anew, though its records hold the same places and times as the chat's", () => {
    const records = journal([turnStarted(one), userMessage("Hello."), assistantMessage("Hello!"), turnEnded(one, { _tag: "Completed" })])
    const board = records.reduce(stored, emptyChat)
    // The same journal: `continues` holds for either session, the session alone tells them apart.
    expect(drawsAnew(board, "chat", { session: "chat", journal: records })).toBe(false)
    expect(drawsAnew(board, "chat", { session: "branch", journal: records })).toBe(true)
    expect(drawsAnew(board, "chat", { session: "chat", journal: records.map((record) => ({ ...record, at: 1 })) })).toBe(true)
  })
})

describe("a background task's report in the chat (lesson 17)", () => {
  const report = (outcome: "Finished" | "Failed", text: string) =>
    taskReport({ task: TaskId.make("t1"), parent: SessionId.make("chat"), session: SessionId.make("task-session"), outcome, text })

  test("a stored report is a row of its own, naming the task and how it ended, drawn the same from the journal", () => {
    const records = journal(
      [turnStarted(one), userMessage("In the background, what is 6 * 7?"), assistantMessage("Started task t1.")],
      [turnStarted(TurnNumber.make(2)), report("Finished", "It is 42."), assistantMessage("Task t1 finished: It is 42.")],
      [turnStarted(TurnNumber.make(3)), report("Failed", "The helper gave up.")],
    )
    expect(chatRowsOf(records).map((row) => `${row.kind} (turn ${row.turn}): ${row.text}`)).toEqual([
      "user (turn 1): In the background, what is 6 * 7?",
      "agent (turn 1): Started task t1.",
      "report (turn 2): Report of task t1 (finished): It is 42.",
      "agent (turn 2): Task t1 finished: It is 42.",
      "report (turn 3): Report of task t1 (failed): The helper gave up.",
    ])
    // A message another session sent that is no report the kernel wrote is shown as it was sent, still apart.
    expect(reportLine("hello")).toBe("From another session: hello")
  })

  test("a report takes no waiting message's place: the person's message waits on, and its row becomes its own record's", () => {
    const records = journal([turnStarted(one), userMessage("first"), assistantMessage("done")], [turnStarted(TurnNumber.make(2)), report("Finished", "It is 42.")], [turnStarted(TurnNumber.make(3)), userMessage("waiting")])
    const before = records.slice(0, 3).reduce(stored, emptyChat)
    const waiting = sent(before, "waiting")
    const reported = records.slice(3, 5).reduce(stored, waiting)
    expect(reported.rows.map(told)).toEqual(["user: first", "agent: done", "report: Report of task t1 (finished): It is 42.", "user* (waiting): waiting"])
    const taken = records.slice(5).reduce(stored, reported)
    expect(taken.rows.map(told)).toEqual(["user: first", "agent: done", "report: Report of task t1 (finished): It is 42.", "user: waiting"])
  })
})
