// Lesson 12 on the page's runtime, with Echo: "Run checks" runs the checks of
// checks.ts, each on a stack of its own, and lists each by id and name; the
// page hears nothing of a check, in its traces, its chat or its store; the
// chat works beside them; a check's messages reach the program through the
// shown chat.ts; a file that makes no list of checks is refused in words;
// and each experiment does what the page says.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Context, Effect, Layer, Option, Result } from "effect"
import { LanguageModel } from "effect/ai"
import { dataOf, turnEndedEvent } from "@xandreed/core"
import { scriptedModel } from "@xandreed/sdk"
import type { ModelScript } from "@xandreed/sdk"
import { chatRowsOf, emptyChat, hear, sent } from "../../chat-model.ts"
import type { ChatBoard, ChatRow } from "../../chat-model.ts"
import { applyExperiment, kitLine } from "../../lesson.ts"
import type { Lesson } from "../../lesson.ts"
import { makeBrowserModel } from "../../models/make.ts"
import { loadEcho } from "../../models/mock.ts"
import { modelStream } from "../../models/stream.ts"
import type { LoadedModel } from "../../models/types.ts"
import { KIT_TIMEOUT, LessonRuntime, TURN_RUNNING } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { emptyBoards, heardBy, sessionRow, turnNumbersOf } from "../../trace-model.ts"
import type { Boards } from "../../trace-model.ts"
import { keepTheConversation } from "../keep-the-conversation/lesson.ts"
import { CHAT } from "./chat.source.ts"
import { CHECK_TIMEOUT, testYourAgent } from "./lesson.ts"

// Echo streams a word every 35 ms, and a live check runs five turns of two model calls.
setDefaultTimeout(30_000)

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES: Record<string, string> = Object.fromEntries(testYourAgent.files.map((file) => [file.id, file.defaultText]))
/** The sources as an experiment leaves them: every file it edits. */
const applied = (id: string, sources = SOURCES): Record<string, string> =>
  ({ ...sources, ...Object.fromEntries(Option.getOrThrow(Option.flatMap(Option.fromNullishOr(testYourAgent.experiments[id]), (experiment) => applyExperiment(experiment, (file) => sources[file] ?? "")))) })
/** The sources with one piece of checks.ts replaced: the piece must be there. */
const withChecks = (from: string, to: string, sources = SOURCES): Record<string, string> => {
  const checks = sources.checks ?? ""
  expect({ from, held: checks.split(from).length - 1 }).toEqual({ from, held: 1 })
  return { ...sources, checks: checks.replace(from, () => to) }
}

/** A row as a test reads it: its kind, whether a record is behind it (`*` when none), and its text. */
const told = (row: ChatRow) => `${row.kind}${row.seq === undefined ? "*" : ""}${row.waiting === true ? " (waiting)" : ""}: ${row.text}`

/** A model that follows a script, as the model picked: what the page hands a live check, and what it was sent. */
const scripted = async (script: ModelScript): Promise<{ readonly loaded: LoadedModel; readonly sent: () => Promise<number> }> => {
  const made = await Effect.runPromise(scriptedModel(script))
  const model = await Effect.runPromise(Effect.scoped(Effect.map(Layer.build(made.model), (built) => Context.get(built, LanguageModel.LanguageModel))))
  return {
    loaded: { choice: { id: "scripted", kind: "echo", label: "Scripted", blurb: "A model that follows a script.", memoryMB: 0 }, model, interrupt: () => {}, dispose: () => {} },
    sent: async () => (await Effect.runPromise(made.calls)).length,
  }
}

/** The page: the runtime on a model (Echo when none is given), what it heard, the chat's rows and the Context tab's boards as the page folds them. */
const page = async (sources: Record<string, string> = SOURCES, model: LoadedModel = loadEcho()) => {
  const runtime = await LessonRuntime.create(testYourAgent)
  opened.push(runtime)
  runtime.setModel(model)
  const heard: Array<Trace> = []
  let board: ChatBoard = emptyChat
  let all: Boards = emptyBoards(runtime.conversation)
  runtime.onTrace((trace) => { heard.push(trace); board = hear(board, trace, runtime.conversation); all = heardBy(all, trace, 0) })
  const result = await runtime.start(sources)
  const ended = () => new Promise<void>((resolve) => {
    const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply" || trace._tag === "Failed" || trace._tag === "Ended") { stop(); resolve() } })
  })
  /** Send as the page does: a waiting row, then the message into the queue. */
  const send = (text: string) => { board = sent(board, text); runtime.send(text) }
  /** Send each once the one before is answered: each a turn of its own. */
  const say = async (...texts: ReadonlyArray<string>) => { for (const text of texts) { const done = ended(); send(text); await done } }
  /** Send several at once, as "Send three" does: one turn takes them all. */
  const together = async (texts: ReadonlyArray<string>) => { const done = ended(); texts.forEach(send); await done }
  const replies = () => heard.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))
  const names = async () => (await runtime.journal()).map((event) => `${event.seq} ${event.name}`)
  const rows = () => board.rows.map(told)
  /** Everything of the page a check could have touched: what it heard, its chat, its conversation's journal, its store, its Context tab. */
  const seen = async () => ({
    traces: heard.length, rows: rows(), journal: await runtime.journal(), sessions: await runtime.list(),
    tabs: sessionRow(all).map((tab) => tab.label), turns: Option.match(Option.fromNullishOr(all.boards.get(runtime.conversation)), { onNone: () => [], onSome: turnNumbersOf }),
  })
  /** Run checks, as the button does: each check's id, whether it passed, and what it said. */
  const check = async (over: Record<string, string> = sources) => Result.getOrThrow(await runtime.runKit("checks", over)).map((one) => [one.id, one.passed, one.message])
  return { runtime, heard, result, send, say, together, ended, replies, names, rows, seen, check }
}

const SUM = "What is 2 + 3?"
const SUM_ROWS = [`user: ${SUM}`, "agent: Let me work that out.", 'tool: calculator({"a":2,"op":"+","b":3}) → 5', "agent: The tool answered: calculator says 5."]
const TURN = [
  "1 core.session.turn.started", "2 conversation.user.message", "3 conversation.assistant.message", "4 conversation.tool.result",
  "5 conversation.assistant.message", "6 core.session.turn.ended",
]
const NAMES = {
  sum: "a sum is worked out by the calculator, and the turn answers",
  "wrong-call": "a call the model got wrong is a failed result, and the turn still answers",
  "two-turns": "two messages are two turns, each completed with its answer",
}
const PASSED = [["sum", true, ""], ["wrong-call", true, ""], ["two-turns", true, ""]]
const BROKEN = "record #4: the calculator answered -1, not 5"
/** What the list says of a check stopped at its limit: the words of Effect's own timeout, with the limit. */
const CUT = "Operation timed out after '300ms'"
const NO_MODEL = "nothing in the stack provides LanguageModel, and a part above it needs it (Service not found: effect/ai/LanguageModel)."
/** The sum's check with a `holds` that says what it is given, so the check fails with it: a way to read what a check's program left. */
const SUM_HOLDS = '(turns) => calculated(turns, 5) ?? answered(turns, ["It is 5."]),'

const outcomes = async (runtime: LessonRuntime) => (await runtime.journal()).flatMap((event) => Option.toArray(dataOf(turnEndedEvent, event))).map((ended) => ended.outcome._tag)

describe("lesson 12 on the page (the kernel, Echo)", () => {
  test("Run checks on a new page: three checks, each passed, by id and name, and the page heard nothing: no trace, no row in the chat, no turn in Context", async () => {
    const { runtime, result, heard, seen } = await page()
    expect(result).toEqual({ _tag: "Built" })
    const before = await seen()
    expect(before).toMatchObject({ traces: 0, rows: [], journal: [], tabs: ["Chat"], turns: [] })
    const ran = Result.getOrThrow(await runtime.runKit("checks", SOURCES))
    expect(ran).toEqual([
      { id: "sum", name: NAMES.sum, passed: true, message: "" },
      { id: "wrong-call", name: NAMES["wrong-call"], passed: true, message: "" },
      { id: "two-turns", name: NAMES["two-turns"], passed: true, message: "" },
    ])
    // The three lines of the list, as the page draws them.
    expect(ran.map(kitLine)).toEqual([
      { state: "passed", head: "✓ sum", detail: NAMES.sum },
      { state: "passed", head: "✓ wrong-call", detail: NAMES["wrong-call"] },
      { state: "passed", head: "✓ two-turns", detail: NAMES["two-turns"] },
    ])
    expect(heard).toEqual([])
    expect(await seen()).toEqual(before)
    // The store holds the chat's one conversation: a check's sessions are in a store of its own.
    expect((await runtime.list()).map((header) => [header.id, header.owner])).toEqual([[runtime.conversation, "learner"]])
  })

  test("the chat works beside the checks: a turn before a run and a turn after it, and the run changes nothing the page holds", async () => {
    const { runtime, say, replies, rows, names, seen, check } = await page()
    await say(SUM)
    expect(rows()).toEqual(SUM_ROWS)
    expect(await names()).toEqual(TURN)
    const before = await seen()
    expect(before.turns).toEqual([1])
    expect(runtime.checking).toBe(false)
    expect(await check()).toEqual(PASSED)
    expect(runtime.checking).toBe(false)
    expect(await seen()).toEqual(before)
    // The program still runs, and takes the next message as turn 2 of the same conversation.
    expect(runtime.running).toBe(true)
    await say("What is 12 * 3?")
    expect(replies()).toEqual(["The tool answered: calculator says 5.", "The tool answered: calculator says 36."])
    expect(await outcomes(runtime)).toEqual(["Completed", "Completed"])
    expect((await seen()).turns).toEqual([1, 2])
    // The chat drawn again from the journal shows the same rows: every row has a record behind it.
    expect(rows().filter((row) => /^\w+\*/.test(row))).toEqual([])
    expect(chatRowsOf(await runtime.journal()).map(told)).toEqual(rows())
  })

  test("the three checks call no model: with a model picked that fails every call, each still passes, and that model was sent nothing", async () => {
    const down = await scripted([{ _tag: "Fails" }])
    const { result, check } = await page(SOURCES, down.loaded)
    expect(result).toEqual({ _tag: "Built" })
    expect(await check()).toEqual(PASSED)
    expect(await down.sent()).toBe(0)
  })

  test("a check's messages reach the program through the shown chat.ts, one turn each; its journal, its notes and its sessions are its own", async () => {
    // chat.ts says where a test's pane goes, in the words the page quotes.
    expect(CHAT).toContain("// What a chat pane offers. This page has one; a terminal or a test would have another.")
    const { runtime, say, replies, seen, check, heard } = await page()
    await say("Remember to buy milk.")
    const before = await seen()
    // The last check, made to say the messages each of its turns took: the two the check sent, in order.
    const messages = withChecks('(turns) => answered(turns, ["Hello.", "Hello."]),', "(turns) => JSON.stringify(turns.map((turn) => turn.messages.map((message) => message.text))),")
    expect((await check(messages))[2]).toEqual(["two-turns", false, '[["Hi."],["Still there?"]]'])
    // The same check, made to say the records of its journal: it starts at 1, after two other checks ran, and holds two turns.
    const records = withChecks('(turns) => answered(turns, ["Hello.", "Hello."]),', '(turns) => turns.flatMap((turn) => turn.records.map((record) => `${record.seq} ${record.name}`)).join(", "),')
    expect((await check(records))[2]).toEqual(["two-turns", false, [
      "1 core.session.turn.started", "2 conversation.user.message", "3 conversation.assistant.message", "4 core.session.turn.ended",
      "5 core.session.turn.started", "6 conversation.user.message", "7 conversation.assistant.message", "8 core.session.turn.ended",
    ].join(", ")])
    // The sum's check, made to say its records: the six of the page's list, the tool's result the fourth.
    const sum = withChecks(SUM_HOLDS, '(turns) => turns.flatMap((turn) => turn.records.map((record) => `${record.seq} ${record.name}`)).join(", "),')
    expect((await check(sum))[0]).toEqual(["sum", false, TURN.join(", ")])
    // A turn the model failed in has no answer, and closed as failed.
    const failed = withChecks(SUM_HOLDS, "(turns) => JSON.stringify(turns.map((turn) => [Option.isSome(turn.answer), Option.getOrUndefined(turn.closed)?.outcome._tag])),", withChecks('{ _tag: "Answers", pieces: ["It is 5."] },\n    ],\n    ["What is 2 + 3?"],', '{ _tag: "Fails" },\n    ],\n    ["What is 2 + 3?"],'))
    expect((await check(failed))[0]).toEqual(["sum", false, '[[false,"Failed"]]'])
    // A check whose script saves a note saves it in notes of its own: tools.ts is run again for the checks.
    const noted = withChecks('calls: [{ name: "calculator", params: { a: "two", op: "+", b: 3 } }],', 'calls: [{ name: "remember", params: { note: "from a check" } }],')
    expect((await check(noted))[1]).toEqual(["wrong-call", false, "record #4: the call was answered, not failed"])
    expect(await seen()).toEqual(before)
    expect(heard.filter((trace) => trace._tag === "Taken")).toHaveLength(1)
    await say("What are my notes?")
    expect(replies().at(-1)).toBe('The tool answered: recall says ["buy milk."].')
    expect((await runtime.list()).map((header) => header.owner)).toEqual(["learner"])
  })

  test("what turnsOf gives a check for the sum's turn: its message, a step for each answer with its calls and their results, the answer, how it closed, each with the place of its record", async () => {
    const { check } = await page()
    // The sum's check, made to say the parts of each turn it was given.
    const read = withChecks(SUM_HOLDS, `(turns) =>
      JSON.stringify(
        turns.map((turn) => ({
          turn: turn.turn,
          opened: Option.getOrUndefined(turn.opened),
          messages: turn.messages.map((message) => [message.seq, message.text]),
          steps: turn.steps.map((step) => ({
            seq: step.seq,
            text: step.text,
            calls: step.calls.map((call) => [call.name, call.input, Option.getOrUndefined(call.result)]),
          })),
          answer: Option.getOrUndefined(turn.answer),
          closed: Option.getOrUndefined(turn.closed),
          records: turn.records.length,
        })),
      ),`)
    const [sum] = await check(read)
    expect(sum?.slice(0, 2)).toEqual(["sum", false])
    expect(JSON.parse(String(sum?.[2]))).toEqual([{
      turn: 1,
      opened: 1,
      messages: [[2, "What is 2 + 3?"]],
      steps: [
        { seq: 3, text: "", calls: [["calculator", { a: 2, op: "+", b: 3 }, { seq: 4, result: 5, isFailure: false }]] },
        { seq: 5, text: "It is 5.", calls: [] },
      ],
      answer: "It is 5.",
      closed: { seq: 6, outcome: { _tag: "Completed" } },
      records: 6,
    }])
  })

  test("with a calculator that subtracts (an experiment), the program builds and the chat answers -1; the sum's check fails and names the record and what it held; the other two pass", async () => {
    const broken = applied("break-calculator")
    const { result, say, replies, rows, check, runtime } = await page(broken)
    expect(result).toEqual({ _tag: "Built" })
    await say(SUM)
    expect(replies()).toEqual(["The tool answered: calculator says -1."])
    expect(rows()[2]).toBe('tool: calculator({"a":2,"op":"+","b":3}) → -1')
    expect(await outcomes(runtime)).toEqual(["Completed"])
    expect(await check()).toEqual([["sum", false, BROKEN], ["wrong-call", true, ""], ["two-turns", true, ""]])
    // The failing line, as the list draws it.
    const ran = Result.getOrThrow(await runtime.runKit("checks", broken))
    expect(ran.slice(0, 1).map(kitLine)).toEqual([{ state: "failed", head: "✗ sum", detail: `${NAMES.sum}: ${BROKEN}` }])
    // The lesson's own tools.ts passes again on the same page.
    expect(await check(SOURCES)).toEqual(PASSED)
  })

  test("a check that asks something of every call (an experiment) passes over a script that makes none, and the form that counts first fails on the same script", async () => {
    const { result, check, runtime } = await page(applied("vacuous"))
    expect(result).toEqual({ _tag: "Built" })
    expect(await check()).toEqual([...PASSED, ["every-call", true, ""], ["one-call", false, "0 calls were made, not 1"]])
    const ran = Result.getOrThrow(await runtime.runKit("checks", applied("vacuous")))
    expect(ran.slice(3).map(kitLine)).toEqual([
      { state: "passed", head: "✓ every-call", detail: "every call's result is 5" },
      { state: "failed", head: "✗ one-call", detail: "one call was made, and its result is 5: 0 calls were made, not 1" },
    ])
  })

  test("a live check (an experiment) on Echo: five runs of five pass, within the check's limit, and the page hears nothing of them", async () => {
    const live = applied("live")
    const { result, say, seen, runtime, heard } = await page(live)
    expect(result).toEqual({ _tag: "Built" })
    await say(SUM)
    const before = await seen()
    const started = performance.now()
    const ran = Result.getOrThrow(await runtime.runKit("checks", live))
    const took = performance.now() - started
    expect(ran.map((one) => [one.id, one.passed, one.message])).toEqual([...PASSED, ["live-sum", true, "5 of 5 runs passed"]])
    expect(ran.slice(3).map(kitLine)).toEqual([{ state: "passed", head: "✓ live-sum", detail: "the model you picked works out 2 + 3 with the calculator: 5 of 5 runs passed" }])
    // The model picked is the one thing a check shares with the page, and the page heard no prompt of it: nothing
    // it holds changed across ten model calls.
    expect(await seen()).toEqual(before)
    expect(heard.filter((trace) => trace._tag === "Prompt")).toHaveLength(2)
    // On Echo the five runs take about two seconds: far inside the limit the kit states.
    expect(took).toBeLessThan(10_000)
    expect([testYourAgent.kits?.checks?.timeout, CHECK_TIMEOUT]).toEqual(["2 minutes", "2 minutes"])
    // The chat goes on after it.
    await say(SUM)
    expect((await seen()).turns).toEqual([1, 2])
  })

  test("a live check cut at its limit stops the model where it is: the stream it was reading is cancelled, the checks are over, and the chat answers its next turn", async () => {
    // A model that starts an answer and never ends it, built as the page's models are: over a source with a cancel.
    let started = 0
    let cancelled = 0
    const stalled: LoadedModel = {
      choice: { id: "stalled", kind: "echo", label: "Stalled", blurb: "A model that never ends its answer.", memoryMB: 0 },
      model: makeBrowserModel("stalled", {
        generateText: () => Effect.die("the stalled model only streams"),
        streamText: () => modelStream("Stalled", (sink) => { started++; sink.push("One"); return () => { cancelled++ } }) as never,
      }, "native"),
      interrupt: () => {},
      dispose: () => {},
    }
    // The lesson, with a limit a test can wait for.
    const kit = testYourAgent.kits?.checks
    if (kit === undefined) throw new Error("the lesson has no checks")
    const short: Lesson = { ...testYourAgent, kits: { checks: { ...kit, timeout: "300 millis" } } }
    const runtime = await LessonRuntime.create(short)
    opened.push(runtime)
    runtime.setModel(stalled)
    const live = applied("live")
    expect(await runtime.start(live)).toEqual({ _tag: "Built" })
    const ran = Result.getOrThrow(await runtime.runKit("checks", live))
    // The three scripted checks call no model. The live one was cut in its first run, at the model's first call.
    expect(ran.map((one) => [one.id, one.passed])).toEqual([["sum", true], ["wrong-call", true], ["two-turns", true], ["live-sum", false]])
    expect(ran[3]?.message).toBe(CUT)
    expect([started, cancelled]).toEqual([1, 1])
    expect(runtime.checking).toBe(false)
    // The chat goes on: with a model that answers picked, and the program started on it as the page does, its
    // next turn is answered.
    runtime.setModel(loadEcho())
    expect(await runtime.start(live)).toEqual({ _tag: "Built" })
    const replied = new Promise<string>((resolve) => { const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply") { stop(); resolve(trace.text) } }) })
    runtime.send(SUM)
    expect(await replied).toBe("The tool answered: calculator says 5.")
    expect(started).toBe(1)
  })

  test("a live check on a model that misses runs fails with its rate: three runs of five, and a calculator that subtracts none of five", async () => {
    const call: ModelScript[number] = { _tag: "Calls", pieces: [], calls: [{ name: "calculator", params: { a: 2, op: "+", b: 3 } }] }
    const says: ModelScript[number] = { _tag: "Answers", pieces: ["Five."] }
    // Three runs call the calculator and answer; in the last two the model answers by itself.
    const some = await scripted([call, says, call, says, call, says, says])
    const { runtime, check } = await page(applied("live"), some.loaded)
    const ran = Result.getOrThrow(await runtime.runKit("checks", applied("live")))
    expect(ran.map((one) => [one.id, one.passed, one.message])).toEqual([...PASSED, ["live-sum", false, "3 of 5 runs passed. The first that did not: 0 calls were made, not 1"]])
    expect(ran.slice(3).map(kitLine)).toEqual([{ state: "failed", head: "✗ live-sum", detail: "the model you picked works out 2 + 3 with the calculator: 3 of 5 runs passed. The first that did not: 0 calls were made, not 1" }])
    // Three runs of two model calls and two of one: the live check sent the model picked eight prompts, the scripted checks none.
    expect(await some.sent()).toBe(8)
    // On Echo with the broken calculator, every run works out -1.
    runtime.setModel(loadEcho())
    expect(await check(applied("live", applied("break-calculator")))).toEqual([["sum", false, BROKEN], ["wrong-call", true, ""], ["two-turns", true, ""], ["live-sum", false, "0 of 5 runs passed. The first that did not: record #4: the calculator answered -1, not 5"]])
  })

  test("a stack with the model's line taken out fails every check in words: the page finds when the program runs what TypeScript refuses before", async () => {
    const { check, result } = await page()
    expect(result).toEqual({ _tag: "Built" })
    const without = withChecks("      Effect.provide(model), // a model that follows a script, or the model you picked\n", "")
    expect(await check(without)).toEqual([["sum", false, NO_MODEL], ["wrong-call", false, NO_MODEL], ["two-turns", false, NO_MODEL]])
  })

  test("a checks.ts that makes no list of checks is refused, by the build and by Run checks, in words that name the file; the chat is untouched", async () => {
    const { runtime, say, names, check } = await page()
    await say(SUM)
    const before = await names()
    const none = "checks.ts did not run: checks is not a list of checks. It should be an array, each entry made with check(id, name, script, messages, holds)."
    const wrong = { ...SOURCES, checks: "const checks = 42" }
    expect(await runtime.start(wrong)).toEqual({ _tag: "Refused", message: none })
    expect(runtime.running).toBe(false)
    expect(await runtime.runKit("checks", wrong)).toEqual(Result.fail(none))
    // A syntax error is said by the file's name too.
    expect(await runtime.runKit("checks", { ...SOURCES, checks: "const checks = [" })).toMatchObject({ _tag: "Failure", failure: expect.stringContaining("checks.ts did not run: ") })
    expect(await names()).toEqual(before)
    // The lesson's own file builds again, over the same conversation, and its checks run.
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    expect(await check()).toEqual(PASSED)
    // With no model picked there is nothing to run a live check on: the kit says so.
    const bare = await LessonRuntime.create(testYourAgent)
    opened.push(bare)
    expect(await bare.runKit("checks", SOURCES)).toEqual(Result.fail("Pick a model first."))
  })

  test("the checks and the chat take turns: Run checks is refused while a turn runs, and the page is told while the checks run", async () => {
    const { runtime, send, ended, check, replies } = await page(applied("live"))
    const done = ended()
    send(SUM)
    // The turn is open once its first record is stored.
    await new Promise<void>((resolve) => { const stop = runtime.onTrace((trace) => { if (trace._tag === "Event") { stop(); resolve() } }) })
    expect(runtime.busy).toBe(true)
    expect(await runtime.runKit("checks", SOURCES)).toEqual(Result.fail(TURN_RUNNING))
    expect(TURN_RUNNING).toBe("a turn is running in the chat. Run this when it has answered.")
    expect(runtime.checking).toBe(false)
    await done
    expect(replies()).toEqual(["The tool answered: calculator says 5."])
    // While the checks run the page reads `checking`, and turns the chat's Send off; a second run is refused.
    const running = runtime.runKit("checks", applied("live"))
    expect(runtime.checking).toBe(true)
    expect(await runtime.runKit("checks", SOURCES)).toEqual(Result.fail("it is running already."))
    expect(Result.getOrThrow(await running).map((one) => one.passed)).toEqual([true, true, true, true])
    expect(runtime.checking).toBe(false)
    expect(await check(SOURCES)).toEqual(PASSED)
    // The kit says so itself. Lesson 7's kit says neither: it runs beside the chat, with five seconds a check.
    expect(testYourAgent.kits?.checks?.alone).toBe(true)
    expect([keepTheConversation.kits?.store?.alone, keepTheConversation.kits?.store?.timeout, KIT_TIMEOUT]).toEqual([undefined, undefined, "5 seconds"])
  })

  test("\"Send three at once\" is one turn that saves a note, works out the sum and reads the notes in one step; the chips, the experiments and the files", async () => {
    expect(testYourAgent.three).toEqual(["Remember to buy milk.", SUM, "What are my notes?"])
    expect(testYourAgent.chips).toEqual([SUM, "What is 12 * 3?", "Remember to buy milk.", "What are my notes?"])
    const { together, replies, rows, runtime } = await page()
    await together(testYourAgent.three)
    expect(replies()).toEqual(['The tools answered: remember says "Saved. 1 notes so far."; calculator says 5; recall says ["buy milk."].'])
    expect(rows().slice(3)).toEqual([
      "agent: Let me use 3 tools.", 'tool: remember({"note":"buy milk."}) → "Saved. 1 notes so far."', 'tool: calculator({"a":2,"op":"+","b":3}) → 5', 'tool: recall({}) → ["buy milk."]',
      'agent: The tools answered: remember says "Saved. 1 notes so far."; calculator says 5; recall says ["buy milk."].',
    ])
    expect(await outcomes(runtime)).toEqual(["Completed"])
    for (const [id, experiment] of Object.entries(testYourAgent.experiments)) {
      const edits = Option.getOrThrow(applyExperiment(experiment, (file) => SOURCES[file] ?? ""))
      expect({ id, changed: edits.every(([file, text]) => text !== SOURCES[file]) }).toEqual({ id, changed: true })
    }
    expect(Object.entries(testYourAgent.experiments).map(([id, experiment]) => [id, experiment.file])).toEqual([["break-calculator", "tools"], ["vacuous", "checks"], ["live", "checks"]])
    expect(testYourAgent.controls).toEqual({})
    expect(testYourAgent.mainFile).toBe("checks")
    // The lesson is not durable: a reload starts from the starter code and an empty conversation.
    expect(testYourAgent.durable).toBeUndefined()
  })
})
