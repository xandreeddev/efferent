// Lesson 9 on the page's runtime, with Echo: `forget` asks before it deletes,
// the question is a row of the chat that goes when it is answered or dropped,
// the answer is a record between the call and its result, a yes for good is
// that record and so outlives a rebuild and not a new conversation, and each
// experiment does what the page says. Questions are answered through
// `runtime.decide`, as the chat's buttons answer them.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Option } from "effect"
import { dataOf, toolResultEvent, turnEndedEvent } from "@xandreed/core"
import { APPROVAL_REFUSED, decidedEvent, grantsOf } from "@xandreed/sdk"
import type { Decision } from "@xandreed/sdk"
import { chatRowsOf, emptyChat, hear, questionsWaiting, sent } from "../../chat-model.ts"
import type { ChatBoard, ChatRow } from "../../chat-model.ts"
import { loadEcho } from "../../models/mock.ts"
import { LessonRuntime } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { emptyBoard, record, viewOf } from "../../trace-model.ts"
import { approvals } from "./lesson.ts"

// Echo streams a word every 35 ms, and these conversations run up to eight turns.
setDefaultTimeout(60_000)

declare global {
  /** The notes of a tools.ts edited for a test, kept where the test can read them: the page runs the file again on every build. */
  var approvalsLessonNotes: Array<string>
}

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES: Record<string, string> = Object.fromEntries(approvals.files.map((file) => [file.id, file.defaultText]))
const applied = (id: string, sources = SOURCES) => {
  const experiment = approvals.experiments[id]!
  return { ...sources, [experiment.file]: Option.getOrThrow(experiment.apply(sources[experiment.file] ?? "")) }
}

/**
 * The lesson's files with one line of tools.ts changed for a test: the notes are an array the test holds. Stop, a
 * rebuild and Clear context all run tools.ts again, which makes its notes anew, so the file's own array cannot
 * show whether `forget` ran before them.
 */
const keptNotes = (): Record<string, string> => {
  globalThis.approvalsLessonNotes = []
  const tools = SOURCES.tools!.replace("const notes = []", "const notes = globalThis.approvalsLessonNotes")
  expect(tools).not.toBe(SOURCES.tools)
  return { ...SOURCES, tools }
}

type Question = Extract<Trace, { readonly _tag: "Asking" }>

/** A row as a test reads it: its kind, whether a record is behind it (`*` when none), and its text. */
const told = (row: ChatRow) => `${row.kind}${row.seq === undefined ? "*" : ""}${row.waiting === true ? " (waiting)" : ""}: ${row.text}`

/** The page: the runtime on Echo, what it heard, and the chat's rows as the page folds them from what it hears. */
const page = async (sources: Record<string, string> = SOURCES) => {
  const runtime = await LessonRuntime.create(approvals)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<Trace> = []
  let board: ChatBoard = emptyChat
  runtime.onTrace((trace) => { heard.push(trace); board = hear(board, trace, runtime.conversation) })
  const result = await runtime.start(sources)
  const until = <T extends Trace>(match: (trace: Trace) => trace is T) => new Promise<T>((resolve) => {
    const stop = runtime.onTrace((trace) => { if (match(trace)) { stop(); resolve(trace) } })
  })
  const isQuestion = (trace: Trace): trace is Question => trace._tag === "Asking"
  const isEnd = (trace: Trace): trace is Trace => trace._tag === "Reply" || trace._tag === "Failed" || trace._tag === "Ended"
  /** Send as the page does: a waiting row, then the message into the queue. */
  const send = (text: string) => { board = sent(board, text); runtime.send(text) }
  /** Send each once the one before is answered: each a turn of its own. */
  const say = async (...texts: ReadonlyArray<string>) => { for (const text of texts) { const done = until(isEnd); send(text); await done } }
  /** Send a message whose turn asks, and wait for the question. */
  const ask = async (text: string): Promise<Question> => { const question = until(isQuestion); send(text); return question }
  /** Answer a question as a button of the chat does, and wait for the turn's reply. */
  const answer = async (id: string, decision: Decision) => { const done = until(isEnd); runtime.decide(id, decision); await done }
  /** Answer a question, and wait for the next one of the same turn. */
  const answerThenAsked = async (id: string, decision: Decision): Promise<Question> => { const question = until(isQuestion); runtime.decide(id, decision); return question }
  const replies = () => heard.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))
  const prompts = () => heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace] : []))
  const questions = () => heard.flatMap((trace) => (trace._tag === "Asking" ? [trace] : []))
  const dropped = () => heard.flatMap((trace) => (trace._tag === "Asked" ? [trace.id] : []))
  /** The journal of the conversation shown: each record's place and name. */
  const names = async () => (await runtime.journal()).map((event) => `${event.seq} ${event.name}`)
  /** The answers the journal of the conversation shown holds. */
  const decisions = async () => (await runtime.journal()).flatMap((event) => Option.toArray(dataOf(decidedEvent, event))).map((one) => [one.action, one.detail, one.decision._tag])
  /** Every stored record the page heard announced, in any conversation, by name. */
  const stored = (name: string) => heard.flatMap((trace) => (trace._tag === "Event" && trace.event._tag === "Stored" && trace.event.name === name ? [trace.event] : []))
  /** The results of `forget` the page heard stored, in any conversation. */
  const forgotten = () => stored(toolResultEvent.name).flatMap((event) => (event.message?._tag === "ToolResult" && event.message.name === "forget" ? [event.message.result] : []))
  const rows = () => board.rows.map(told)
  /** Clear context, as the page does it: the rows as the stopped program left them, then an empty chat. */
  const clear = async () => { const built = await runtime.clear(); const left = rows(); board = emptyChat; return { built, left } }
  return { runtime, heard, result, send, say, ask, answer, answerThenAsked, replies, prompts, questions, dropped, names, decisions, stored, forgotten, rows, board: () => board, clear }
}

const NOTES = ["Remember to buy milk.", "Remember to call Ana."]
const SAVED = ['The tool answered: remember says "Saved. 1 notes so far.".', 'The tool answered: remember says "Saved. 2 notes so far.".']
const BOTH = 'The tool answered: recall says ["buy milk.","call Ana."].'
const NOT_APPROVED = "I did not delete anything: you did not approve it."
const outcomes = async (runtime: LessonRuntime) => (await runtime.journal()).flatMap((event) => Option.toArray(dataOf(turnEndedEvent, event))).map((ended) => ended.outcome._tag)

describe("lesson 9 on the page (the kernel, Echo)", () => {
  test("forget asks before it deletes: the question is a row of the chat, in the tool's words, and Refuse leaves the notes and tells the model", async () => {
    const { result, say, ask, answer, replies, rows, board, questions, dropped, names, decisions, prompts, runtime, heard } = await page()
    expect(result).toEqual({ _tag: "Built" })
    await say(...NOTES)
    const question = await ask("Forget my notes.")
    // The question: the action it names, and what this call would do.
    expect(question).toEqual({ _tag: "Asking", id: "question-1", action: "notes.forget", detail: "Delete all 2 notes." })
    // Its row: the detail, said and not stored, with the id and the action its buttons use. The chip reads it as waiting.
    expect(rows().slice(-3)).toEqual(["user: Forget my notes.", "agent: Let me work that out.", "ask*: Delete all 2 notes."])
    expect(board().rows.at(-1)?.ask).toEqual({ id: "question-1", action: "notes.forget" })
    expect(questionsWaiting(board())).toBe(1)
    // While it waits the turn is open, and nothing is decided or run yet.
    expect(runtime.busy).toBe(true)
    expect(await decisions()).toEqual([])
    expect((await names()).slice(12)).toEqual(["13 core.session.turn.started", "14 conversation.user.message", "15 conversation.assistant.message"])

    await answer(question.id, { _tag: "Refused" })
    // The row is gone, and the page was told the question no longer waits.
    expect(dropped()).toEqual(["question-1"])
    expect(questionsWaiting(board())).toBe(0)
    expect(rows().some((row) => row.startsWith("ask"))).toBe(false)
    // Echo says nothing was deleted, and the notes are both there.
    expect(replies()).toEqual([...SAVED, NOT_APPROVED])
    await say("What are my notes?")
    expect(replies().at(-1)).toBe(BOTH)
    // One question for the whole conversation.
    expect(questions()).toHaveLength(1)
    // The chat's rows for the turn: the answer as a note, then the call's failed result, in the kernel's words.
    expect(rows().slice(8, 13)).toEqual([
      "user: Forget my notes.",
      "agent: Let me work that out.",
      "note: Refused: Delete all 2 notes.",
      `tool: forget({}) failed: ${JSON.stringify(APPROVAL_REFUSED)}`,
      `agent: ${NOT_APPROVED}`,
    ])
    // The model read the refusal as the tool's answer: the last message of the turn's second prompt.
    const second = prompts().filter((prompt) => prompt.turn === 3)[1]!
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", text: `forget failed: ${JSON.stringify(APPROVAL_REFUSED)}` })
    // The events log has the question, in the turn that asked.
    const log = heard.reduce((all, trace) => record(all, trace, 0), emptyBoard(runtime.conversation)).log
    expect(log.filter((entry) => entry.title.startsWith("approval")).map((entry) => [entry.turn, entry.title, entry.detail])).toEqual([[3, "approval asked: notes.forget", "Delete all 2 notes."]])
  })

  test("the answer is a record of the turn, between the call and its result: tagged trace, with no message, and no prompt carries it", async () => {
    const { say, ask, answer, names, decisions, prompts, runtime, heard } = await page()
    await say(...NOTES)
    await answer((await ask("Forget my notes.")).id, { _tag: "Refused" })
    await say("What are my notes?")
    // Turn 3's records: record 16 is the answer, after the model's call (15) and before the call's result (17).
    expect((await names()).slice(12, 19)).toEqual([
      "13 core.session.turn.started", "14 conversation.user.message", "15 conversation.assistant.message",
      "16 plugin.approval.decided", "17 conversation.tool.result", "18 conversation.assistant.message", "19 core.session.turn.ended",
    ])
    expect(await decisions()).toEqual([["notes.forget", "Delete all 2 notes.", "Refused"]])
    const decided = (await runtime.journal())[15]!
    expect([decided.seq, decided.name, decided.tags, decided.message, decided.data]).toEqual([
      16, "plugin.approval.decided", ["trace"], undefined, { action: "notes.forget", detail: "Delete all 2 notes.", decision: { _tag: "Refused" } },
    ])
    // The Context tab's journal for the turn: the record is not conversation, so memory sends none of it.
    const view = viewOf(heard.reduce((all, trace) => record(all, trace, 0), emptyBoard(runtime.conversation)), 3)
    expect(view.calls.at(-1)!.journal.filter((row) => row.turn === 3).map((row) => [row.seq, row.name, row.use])).toEqual([
      [13, "core.session.turn.started", "not-conversation"], [14, "conversation.user.message", "in-context"], [15, "conversation.assistant.message", "in-context"],
      [16, "plugin.approval.decided", "not-conversation"], [17, "conversation.tool.result", "in-context"], [18, "conversation.assistant.message", "later"],
      [19, "core.session.turn.ended", "not-conversation"],
    ])
    // No prompt of this turn or the next holds the request's words: what the model reads of it is the call's result.
    expect(prompts().flatMap((prompt) => prompt.messages).filter((message) => message.text.includes("Delete all 2 notes") || message.text.includes("notes.forget"))).toEqual([])
  })

  test("Approve lets forget run: the notes are deleted, and the answer is stored as Approved", async () => {
    const { say, ask, answer, replies, rows, decisions } = await page()
    await say(...NOTES)
    await answer((await ask("Forget my notes.")).id, { _tag: "Approved" })
    expect(replies().at(-1)).toBe('The tool answered: forget says "Deleted 2 notes.".')
    expect(rows().slice(-3)).toEqual(["note: Approved: Delete all 2 notes.", 'tool: forget({}) → "Deleted 2 notes."', 'agent: The tool answered: forget says "Deleted 2 notes.".'])
    await say("What are my notes?")
    expect(replies().at(-1)).toBe("The tool answered: recall says [].")
    expect(await decisions()).toEqual([["notes.forget", "Delete all 2 notes.", "Approved"]])
    // Approved once covers that call only: the next forget is asked for again.
    await say("Remember to buy milk.")
    const again = await ask("Forget my notes.")
    expect([again.id, again.detail]).toEqual(["question-2", "Delete all 1 notes."])
    await answer(again.id, { _tag: "Refused" })
    expect(replies().at(-1)).toBe(NOT_APPROVED)
  })

  test("Always: approved for good, the action is not asked for again; the grant is the record, so a rebuild keeps it and a new conversation does not have it", async () => {
    const { runtime, say, ask, answer, replies, rows, questions, decisions, clear } = await page()
    await say(...NOTES)
    await answer((await ask("Forget my notes.")).id, { _tag: "ApprovedAlways" })
    expect(replies().at(-1)).toBe('The tool answered: forget says "Deleted 2 notes.".')
    expect(rows().at(-3)).toBe("note: Approved for good (notes.forget): Delete all 2 notes.")
    expect(grantsOf(await runtime.journal())).toEqual(["notes.forget"])
    // Asked again in the same conversation, forget runs with nobody asked, and nothing more is stored about it.
    await say("Remember to water the plants.", "Forget my notes.")
    expect(replies().at(-1)).toBe('The tool answered: forget says "Deleted 1 notes.".')
    expect(questions()).toHaveLength(1)
    expect(await decisions()).toEqual([["notes.forget", "Delete all 2 notes.", "ApprovedAlways"]])
    expect(rows().slice(-4)).toEqual(["user: Forget my notes.", "agent: Let me work that out.", 'tool: forget({}) → "Deleted 1 notes."', 'agent: The tool answered: forget says "Deleted 1 notes.".'])
    // Rebuild: the program starts again over the same journal. tools.ts ran again, so the notes are gone; the grant is not.
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    await say("Forget my notes.")
    expect(replies().at(-1)).toBe('The tool answered: forget says "Deleted 0 notes.".')
    expect(questions()).toHaveLength(1)
    expect(grantsOf(await runtime.journal())).toEqual(["notes.forget"])
    // Clear context: another conversation, whose journal holds no grant. forget asks again.
    expect((await clear()).built).toEqual({ _tag: "Built" })
    expect(grantsOf(await runtime.journal())).toEqual([])
    await say("Remember to buy milk.")
    const again = await ask("Forget my notes.")
    expect(again).toEqual({ _tag: "Asking", id: "question-2", action: "notes.forget", detail: "Delete all 1 notes." })
    expect(rows().at(-1)).toBe("ask*: Delete all 1 notes.")
    await answer(again.id, { _tag: "Refused" })
    expect(replies().at(-1)).toBe(NOT_APPROVED)
  })

  test("the page's own path: two notes, a refusal, a yes for good, a note more, a rebuild, then a new conversation", async () => {
    const { runtime, say, ask, answer, replies, rows, questions, decisions, names, clear } = await page()
    // Steps 1 to 5: two notes, forget refused, and the notes read back.
    await say(...NOTES)
    await answer((await ask("Forget my notes.")).id, { _tag: "Refused" })
    await say("What are my notes?")
    // Step 6: asked again, since a refusal is no standing answer. This time, yes for good.
    const second = await ask("Forget my notes.")
    expect([second.id, second.action, second.detail]).toEqual(["question-2", "notes.forget", "Delete all 2 notes."])
    await answer(second.id, { _tag: "ApprovedAlways" })
    expect(rows().slice(-3)).toEqual(["note: Approved for good (notes.forget): Delete all 2 notes.", 'tool: forget({}) → "Deleted 2 notes."', 'agent: The tool answered: forget says "Deleted 2 notes.".'])
    // A note more, and forget again: no question, and the turn holds the call and its result with nothing between.
    await say("Remember to buy milk.", "Forget my notes.")
    expect(replies()).toEqual([
      ...SAVED, NOT_APPROVED, BOTH,
      'The tool answered: forget says "Deleted 2 notes.".',
      'The tool answered: remember says "Saved. 1 notes so far.".',
      'The tool answered: forget says "Deleted 1 notes.".',
    ])
    expect(questions()).toHaveLength(2)
    expect((await names()).slice(-6).map((name) => name.replace(/^\d+ /, ""))).toEqual([
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "conversation.tool.result", "conversation.assistant.message", "core.session.turn.ended",
    ])
    // Two answers in the journal, and the second is the grant.
    expect(await decisions()).toEqual([["notes.forget", "Delete all 2 notes.", "Refused"], ["notes.forget", "Delete all 2 notes.", "ApprovedAlways"]])
    expect(grantsOf(await runtime.journal())).toEqual(["notes.forget"])
    // Step 7: Rebuild. tools.ts ran again, so there is no note to delete; the journal is the same, so nobody is asked.
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    await say("Forget my notes.")
    expect(replies().at(-1)).toBe('The tool answered: forget says "Deleted 0 notes.".')
    expect(questions()).toHaveLength(2)
    // Clear context: a journal of its own, with no grant in it. forget asks again.
    expect((await clear()).built).toEqual({ _tag: "Built" })
    await say("Remember to buy milk.")
    const third = await ask("Forget my notes.")
    expect([third.id, third.detail]).toEqual(["question-3", "Delete all 1 notes."])
    expect(grantsOf(await runtime.journal())).toEqual([])
  })

  test("Stop, a rebuild and Clear context each run tools.ts again: with the lesson's own files the notes are gone afterwards, though forget never ran", async () => {
    for (const how of ["stop", "rebuild", "clear"] as const) {
      const { runtime, say, ask, replies, forgotten, stored, clear } = await page()
      await say(...NOTES)
      await ask("Forget my notes.")
      if (how === "stop") await runtime.stop()
      if (how === "rebuild") await runtime.start(SOURCES)
      if (how === "clear") await clear()
      await say("What are my notes?")
      expect({ how, reply: replies().at(-1) }).toEqual({ how, reply: "The tool answered: recall says []." })
      // Not by forget: it returned nothing, and nobody decided.
      expect({ how, forgotten: forgotten(), decided: stored(decidedEvent.name) }).toEqual({ how, forgotten: [], decided: [] })
    }
  })

  test("Stop while a question waits: the row goes, no answer is stored, and forget does not run", async () => {
    const { runtime, say, ask, rows, board, dropped, decisions, stored, forgotten, names } = await page(keptNotes())
    await say(...NOTES)
    const question = await ask("Forget my notes.")
    expect(rows().at(-1)).toBe("ask*: Delete all 2 notes.")
    expect((await runtime.stop()).result).toEqual({ _tag: "Built" })
    // The question was taken back, and its row with it: what is left is the stopped turn's line.
    expect(dropped()).toEqual([question.id])
    expect(questionsWaiting(board())).toBe(0)
    expect(rows().slice(-3)).toEqual(["user: Forget my notes.", "agent: Let me work that out.", "note: Turn 3 was stopped. Your message stays in the journal."])
    // Nobody decided: no record of an answer, and no result for the call.
    expect(await decisions()).toEqual([])
    expect(stored(decidedEvent.name)).toEqual([])
    expect(forgotten()).toEqual([])
    expect((await names()).slice(12)).toEqual(["13 core.session.turn.started", "14 conversation.user.message", "15 conversation.assistant.message", "16 core.session.turn.ended"])
    expect(await outcomes(runtime)).toEqual(["Completed", "Completed", "Interrupted"])
    // forget did not run: the notes the test holds are both there.
    expect(globalThis.approvalsLessonNotes).toEqual(["buy milk.", "call Ana."])
    // An answer that comes after the question was dropped does nothing.
    runtime.decide(question.id, { _tag: "Approved" })
    await say("What are my notes?")
    expect(globalThis.approvalsLessonNotes).toEqual(["buy milk.", "call Ana."])
    expect(stored(decidedEvent.name)).toEqual([])
  })

  test("Rebuild while a question waits: the row goes, no answer is stored, and forget does not run", async () => {
    const sources = keptNotes()
    const { runtime, say, ask, rows, board, dropped, decisions, stored, forgotten, prompts } = await page(sources)
    await say(...NOTES)
    const question = await ask("Forget my notes.")
    expect(await runtime.start(sources)).toEqual({ _tag: "Built" })
    expect(dropped()).toEqual([question.id])
    expect(questionsWaiting(board())).toBe(0)
    expect(rows().slice(-3)).toEqual(["user: Forget my notes.", "agent: Let me work that out.", "note: Turn 3 was stopped. Your message stays in the journal."])
    expect(await decisions()).toEqual([])
    expect(stored(decidedEvent.name)).toEqual([])
    expect(forgotten()).toEqual([])
    expect(await outcomes(runtime)).toEqual(["Completed", "Completed", "Interrupted"])
    expect(globalThis.approvalsLessonNotes).toEqual(["buy milk.", "call Ana."])
    // The call no result answers is not sent again: the next turn's prompt holds the message and the model's words, no call.
    await say("Hello again.")
    expect(prompts().at(-1)!.messages.slice(-3).map((message) => [message.role, message.text])).toEqual([["user", "Forget my notes."], ["assistant", "Let me work that out."], ["user", "Hello again."]])
    expect(forgotten()).toEqual([])
    expect(globalThis.approvalsLessonNotes).toEqual(["buy milk.", "call Ana."])
  })

  test("Clear context while a question waits: the row goes, no answer is stored, and forget does not run", async () => {
    const { runtime, say, ask, rows, board, dropped, stored, forgotten, clear } = await page(keptNotes())
    await say(...NOTES)
    const question = await ask("Forget my notes.")
    const before = runtime.conversation
    const { built, left } = await clear()
    expect(built).toEqual({ _tag: "Built" })
    // The stopped program took the question back before the chat was emptied.
    expect(dropped()).toEqual([question.id])
    expect(left.some((row) => row.startsWith("ask"))).toBe(false)
    expect(runtime.conversation).not.toBe(before)
    expect(questionsWaiting(board())).toBe(0)
    expect(rows()).toEqual([])
    // No answer was stored in the old conversation or the new one, and forget returned nothing.
    expect(stored(decidedEvent.name)).toEqual([])
    expect(forgotten()).toEqual([])
    expect(await runtime.journal()).toEqual([])
    expect(globalThis.approvalsLessonNotes).toEqual(["buy milk.", "call Ana."])
  })

  test("a decision for an id nothing waits under does nothing, and a question is answered once", async () => {
    const { runtime, say, ask, answer, board, dropped, decisions, replies } = await page()
    await say(...NOTES)
    // No question waits yet.
    runtime.decide("question-1", { _tag: "Approved" })
    const question = await ask("Forget my notes.")
    expect(question.id).toBe("question-1")
    // An id no question has: the one that waits still waits.
    runtime.decide("question-99", { _tag: "Approved" })
    runtime.decide("", { _tag: "Approved" })
    expect(questionsWaiting(board())).toBe(1)
    expect(dropped()).toEqual([])
    expect(await decisions()).toEqual([])
    // Answered twice at once, as two presses would: the first answer stands.
    const done = answer(question.id, { _tag: "Refused" })
    runtime.decide(question.id, { _tag: "Approved" })
    await done
    expect(await decisions()).toEqual([["notes.forget", "Delete all 2 notes.", "Refused"]])
    expect(replies().at(-1)).toBe(NOT_APPROVED)
  })

  test("a message sent while a question waits is taken like every message sent during a turn: it waits, and joins the turn once the tool has answered", async () => {
    const { say, ask, answer, send, rows, names } = await page()
    await say(...NOTES)
    const question = await ask("Forget my notes.")
    send("What is 2 + 2?")
    expect(rows().slice(-2)).toEqual(["ask*: Delete all 2 notes.", "user* (waiting): What is 2 + 2?"])
    await answer(question.id, { _tag: "Approved" })
    // One turn: the message is stored after forget's result, and its sum is worked out before the turn ends.
    expect((await names()).slice(12)).toEqual([
      "13 core.session.turn.started", "14 conversation.user.message", "15 conversation.assistant.message", "16 plugin.approval.decided",
      "17 conversation.tool.result", "18 conversation.user.message", "19 conversation.assistant.message", "20 conversation.tool.result",
      "21 conversation.assistant.message", "22 core.session.turn.ended",
    ])
    expect(rows().filter((row) => row.includes("(waiting)"))).toEqual([])
  })

  test("the chat drawn again from the journal shows the same rows, the notes of each answer included, and no question", async () => {
    const { runtime, say, ask, answer, rows } = await page()
    await say(...NOTES)
    await answer((await ask("Forget my notes.")).id, { _tag: "Refused" })
    await answer((await ask("Forget my notes.")).id, { _tag: "Approved" })
    await say("Remember to buy milk.")
    await answer((await ask("Forget my notes.")).id, { _tag: "ApprovedAlways" })
    const redrawn = chatRowsOf(await runtime.journal()).map(told)
    expect(redrawn.filter((row) => row.startsWith("note"))).toEqual([
      "note: Refused: Delete all 2 notes.",
      "note: Approved: Delete all 2 notes.",
      "note: Approved for good (notes.forget): Delete all 1 notes.",
    ])
    // Every row of the live chat has a record behind it, and the journal alone gives the same rows in the same order.
    expect(rows().filter((row) => /^\w+\*/.test(row))).toEqual([])
    expect(redrawn).toEqual(rows())
  })

  test("with a policy that allows everything (an experiment), nobody is asked: the record says Allowed, the chat says so, and no grant stands", async () => {
    const { result, runtime, say, replies, rows, questions, decisions } = await page(applied("auto-approve"))
    expect(result).toEqual({ _tag: "Built" })
    await say(...NOTES, "Forget my notes.", "What are my notes?")
    expect(questions()).toEqual([])
    expect(replies().slice(-2)).toEqual(['The tool answered: forget says "Deleted 2 notes.".', "The tool answered: recall says []."])
    expect(await decisions()).toEqual([["notes.forget", "Delete all 2 notes.", "Allowed"]])
    expect(rows().slice(8, 13)).toEqual([
      "user: Forget my notes.", "agent: Let me work that out.", "note: Allowed by policy: Delete all 2 notes.",
      'tool: forget({}) → "Deleted 2 notes."', 'agent: The tool answered: forget says "Deleted 2 notes.".',
    ])
    // A policy's yes is no standing approval: each call is allowed, and recorded, on its own.
    expect(grantsOf(await runtime.journal())).toEqual([])
    await say("Remember to buy milk.", "Forget my notes.")
    expect((await decisions()).map((one) => one[2])).toEqual(["Allowed", "Allowed"])
    expect(grantsOf(await runtime.journal())).toEqual([])
  })

  test("with no approval given to the program (an experiment), the page runs it, and forget's call fails where it would ask: nothing is deleted", async () => {
    const { result, say, replies, rows, questions, decisions, names } = await page(applied("no-approval"))
    // The page runs the file as JavaScript: nothing checks what main was given until the tool runs.
    expect(result).toEqual({ _tag: "Built" })
    await say(...NOTES, "Forget my notes.", "What are my notes?")
    expect(questions()).toEqual([])
    expect(replies().slice(-2)).toEqual(['The tool answered: forget failed: "Service not found: @xandreed/sdk/Approval".', BOTH])
    expect(rows()[10]).toBe('tool: forget({}) failed: "Service not found: @xandreed/sdk/Approval"')
    // Nobody was asked and nobody decided: the turn holds the call and its failed result, and goes on.
    expect(await decisions()).toEqual([])
    expect((await names()).slice(12, 18)).toEqual([
      "13 core.session.turn.started", "14 conversation.user.message", "15 conversation.assistant.message",
      "16 conversation.tool.result", "17 conversation.assistant.message", "18 core.session.turn.ended",
    ])
  })

  test("with a loop that asks before every call (an experiment), every tool is asked for, the calculator too, and forget twice: by the loop, then by the tool", async () => {
    const { result, say, ask, answer, answerThenAsked, replies, rows, questions, decisions } = await page(applied("ask-in-loop"))
    expect(result).toEqual({ _tag: "Built" })
    const sum = await ask("What is 12 * 3?")
    expect([sum.action, sum.detail]).toEqual(["tool.calculator", 'Call calculator with {"a":12,"op":"*","b":3}.'])
    await answer(sum.id, { _tag: "Approved" })
    const note = await ask("Remember to buy milk.")
    expect([note.action, note.detail]).toEqual(["tool.remember", 'Call remember with {"note":"buy milk."}.'])
    await answer(note.id, { _tag: "Approved" })
    // forget: the loop asks whether to call it, and then the tool asks whether to delete.
    const byLoop = await ask("Forget my notes.")
    expect([byLoop.action, byLoop.detail]).toEqual(["tool.forget", "Call forget with {}."])
    const byTool = await answerThenAsked(byLoop.id, { _tag: "Approved" })
    expect([byTool.action, byTool.detail]).toEqual(["notes.forget", "Delete all 1 notes."])
    await answer(byTool.id, { _tag: "Approved" })
    expect(replies()).toEqual(["The tool answered: calculator says 36.", 'The tool answered: remember says "Saved. 1 notes so far.".', 'The tool answered: forget says "Deleted 1 notes.".'])
    expect(rows().slice(10)).toEqual([
      "user: Forget my notes.", "agent: Let me work that out.", "note: Approved: Call forget with {}.", "note: Approved: Delete all 1 notes.",
      'tool: forget({}) → "Deleted 1 notes."', 'agent: The tool answered: forget says "Deleted 1 notes.".',
    ])
    // Refused by the loop, a call has the refusal as its result, stored by the loop: the tool never runs, and never asks.
    const refused = await ask("What is 2 + 2?")
    await answer(refused.id, { _tag: "Refused" })
    expect(replies().at(-1)).toBe(`The tool answered: calculator failed: ${JSON.stringify(APPROVAL_REFUSED)}.`)
    const forgetRefused = await ask("Forget my notes.")
    await answer(forgetRefused.id, { _tag: "Refused" })
    expect(replies().at(-1)).toBe(NOT_APPROVED)
    expect(questions().map((question) => question.action)).toEqual(["tool.calculator", "tool.remember", "tool.forget", "notes.forget", "tool.calculator", "tool.forget"])
    expect((await decisions()).map((one) => [one[0], one[2]])).toEqual([
      ["tool.calculator", "Approved"], ["tool.remember", "Approved"], ["tool.forget", "Approved"], ["notes.forget", "Approved"], ["tool.calculator", "Refused"], ["tool.forget", "Refused"],
    ])
  })

  test("without the line that asks (an experiment), forget deletes on the model's word: no question, no record of an answer", async () => {
    const { result, say, replies, questions, decisions, rows } = await page(applied("no-ask"))
    expect(result).toEqual({ _tag: "Built" })
    await say(...NOTES, "Forget my notes.", "What are my notes?")
    expect(questions()).toEqual([])
    expect(await decisions()).toEqual([])
    expect(replies().slice(-2)).toEqual(['The tool answered: forget says "Deleted 2 notes.".', "The tool answered: recall says []."])
    expect(rows().slice(8, 12)).toEqual(["user: Forget my notes.", "agent: Let me work that out.", 'tool: forget({}) → "Deleted 2 notes."', 'agent: The tool answered: forget says "Deleted 2 notes.".'])
  })

  test("\"Send three at once\" is one turn that saves two notes and reads them back, with no question asked; every experiment finds its line", async () => {
    expect(approvals.three).toEqual(["Remember to buy milk.", "Remember to call Ana.", "What are my notes?"])
    expect(approvals.chips).toEqual(["Remember to buy milk.", "Remember to call Ana.", "What are my notes?", "Forget my notes."])
    expect(approvals.fill).toEqual(approvals.three)
    const three = await page()
    const done = new Promise<void>((resolve) => { const stop = three.runtime.onTrace((trace) => { if (trace._tag === "Reply") { stop(); resolve() } }) })
    approvals.three.forEach((text) => three.send(text))
    await done
    // One answer for the three messages: none is left unanswered, and nothing waits for a person.
    expect(three.replies()).toEqual(['The tools answered: remember says "Saved. 1 notes so far."; remember says "Saved. 2 notes so far."; recall says ["buy milk.","call Ana."].'])
    expect(three.questions()).toEqual([])
    expect(await outcomes(three.runtime)).toEqual(["Completed"])
    // The tools offered with every prompt: lesson 2's three, and forget.
    expect(three.prompts().map((prompt) => prompt.tools)).toEqual([["calculator", "remember", "recall", "forget"], ["calculator", "remember", "recall", "forget"]])
    for (const [id, experiment] of Object.entries(approvals.experiments)) {
      const source = SOURCES[experiment.file]!
      expect({ id, changed: Option.exists(experiment.apply(source), (next) => next !== source) }).toEqual({ id, changed: true })
    }
    expect(Object.keys(approvals.experiments)).toEqual(["auto-approve", "no-approval", "ask-in-loop", "no-ask"])
    expect(approvals.controls).toEqual({})
  })
})
