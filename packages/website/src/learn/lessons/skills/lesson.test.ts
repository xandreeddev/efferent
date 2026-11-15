// Lesson 10 on the page's runtime, with Echo: a skill is loaded by a tool
// call whose result is its instructions, the skill's tool is offered from the
// next model call, what is loaded is read from the journal (so a rebuild
// keeps it and a new conversation does not have it), and each experiment
// does what the page says. Which tools a model call was offered is read from
// the `Prompt` trace, as the Context tab reads it.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Option } from "effect"
import { dataOf, turnEndedEvent } from "@xandreed/core/kernel"
import { loadedOf } from "@xandreed/sdk/kernel"
import { chatRowsOf, emptyChat, hear, sent } from "../../chat-model.ts"
import type { ChatBoard, ChatRow } from "../../chat-model.ts"
import { loadEcho } from "../../models/mock.ts"
import { LessonRuntime } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { emptyBoard, record, viewOf } from "../../trace-model.ts"
import { skillsLesson } from "./lesson.ts"

// Echo streams a word every 35 ms, and these conversations run up to six turns of two or three model calls.
setDefaultTimeout(60_000)

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES: Record<string, string> = Object.fromEntries(skillsLesson.files.map((file) => [file.id, file.defaultText]))
const applied = (id: string, sources = SOURCES) => {
  const experiment = skillsLesson.experiments[id]!
  return { ...sources, [experiment.file]: Option.getOrThrow(experiment.apply(sources[experiment.file] ?? "")) }
}

/** A row as a test reads it: its kind, whether a record is behind it (`*` when none), and its text. */
const told = (row: ChatRow) => `${row.kind}${row.seq === undefined ? "*" : ""}${row.waiting === true ? " (waiting)" : ""}: ${row.text}`

/** The page: the runtime on Echo, what it heard, and the chat's rows as the page folds them from what it hears. */
const page = async (sources: Record<string, string> = SOURCES) => {
  const runtime = await LessonRuntime.create(skillsLesson)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<Trace> = []
  let board: ChatBoard = emptyChat
  runtime.onTrace((trace) => { heard.push(trace); board = hear(board, trace, runtime.conversation) })
  const result = await runtime.start(sources)
  const ended = () => new Promise<void>((resolve) => {
    const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply" || trace._tag === "Failed" || trace._tag === "Ended") { stop(); resolve() } })
  })
  /** Send as the page does: a waiting row, then the message into the queue. */
  const send = (text: string) => { board = sent(board, text); runtime.send(text) }
  /** Send each once the one before is answered: each a turn of its own. */
  const say = async (...texts: ReadonlyArray<string>) => { for (const text of texts) { const done = ended(); send(text); await done } }
  /** Send several at once, as "Send three" and a fill do: one turn takes them all. */
  const together = async (texts: ReadonlyArray<string>) => { const done = ended(); texts.forEach(send); await done }
  const replies = () => heard.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))
  const failures = () => heard.flatMap((trace) => (trace._tag === "Failed" || trace._tag === "Ended" ? [trace] : []))
  /** Every prompt the model received in the conversation shown now. */
  const prompts = () => heard.flatMap((trace) => (trace._tag === "Prompt" && trace.session === runtime.conversation ? [trace] : []))
  /** The tools each model call of a turn was offered, in order. */
  const offered = (turn: number) => prompts().filter((prompt) => prompt.turn === turn).map((prompt) => prompt.tools)
  /** The Context tab's model of the conversation shown now. */
  const context = () => heard.reduce((all, trace) => record(all, trace, 0), emptyBoard(runtime.conversation))
  /** The journal of the conversation shown: each record's place and name. */
  const names = async () => (await runtime.journal()).map((event) => `${event.seq} ${event.name}`)
  const loaded = async () => loadedOf(await runtime.journal()).map(String)
  const rows = () => board.rows.map(told)
  /** Clear context, as the page does it: an empty chat over a new conversation. */
  const clear = async () => { const built = await runtime.clear(); board = emptyChat; return built }
  return { runtime, heard, result, send, say, together, replies, failures, prompts, offered, context, names, loaded, rows, clear }
}

const KM = "How far is 5 km in miles?"
const RAIN = "Write a haiku about rain."
const SUM = "What is 2 + 3?"

/** What a step offers before any skill is loaded: lesson 2's tools and the kernel's loadSkill. */
const BASE = ["calculator", "remember", "recall", "loadSkill"]
const WITH_CONVERT = [...BASE, "convert"]

const OPENING = "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."
const CATALOGUE = [
  "You have skills: instructions and tools you are not given until you load them. Before you do something a skill covers, call loadSkill with its name and follow what it returns.",
  "- units: Convert a length between kilometres and miles.",
  "- haiku: Answer in a haiku.",
].join("\n")
const SYSTEM = `${OPENING}\n\n${CATALOGUE}`
const UNITS_INSTRUCTIONS = "Convert with the convert tool, never in your head.\nGive it the number as it was written, and each unit as km or mi.\nAnswer with the number and its unit, to one decimal."
const HAIKU_INSTRUCTIONS = "Answer in a haiku: three lines of five, seven and five syllables.\nWrite about what the message names. Add no title and no comment."
const UNITS_LOADED = { skill: "units", instructions: UNITS_INSTRUCTIONS }
const HAIKU_LOADED = { skill: "haiku", instructions: HAIKU_INSTRUCTIONS }

const LOAD_UNITS_ROW = `tool: loadSkill({"skill":"units"}) → ${JSON.stringify(UNITS_LOADED)}`
const LOAD_HAIKU_ROW = `tool: loadSkill({"skill":"haiku"}) → ${JSON.stringify(HAIKU_LOADED)}`
const CONVERT_ROW = 'tool: convert({"value":5,"from":"km","to":"mi"}) → 3.1068559611866697'
const CONVERTED = "5 km is 3.1 mi."
const HAIKU = "An echo answers\nin five, then seven, then five:\nthe skill told it to."
const NOT_FOUND = "Toolkit.convert.handle: Tool 'convert' not found. Available tools: calculator, remember, recall, loadSkill"

const outcomes = async (runtime: LessonRuntime) => (await runtime.journal()).flatMap((event) => Option.toArray(dataOf(turnEndedEvent, event))).map((ended) => ended.outcome._tag)

describe("lesson 10 on the page (the kernel, Echo)", () => {
  test("a message a skill covers is one turn of three model calls: Echo loads the skill, calls its tool, and answers; convert is offered from the second call", async () => {
    const { result, say, replies, failures, rows, offered, names, loaded, runtime } = await page()
    expect(result).toEqual({ _tag: "Built" })
    await say(KM)
    expect(failures()).toEqual([])
    expect(replies()).toEqual([CONVERTED])
    // The chat: the load and its result, which is the skill's instructions; then the skill's tool and its number.
    expect(rows()).toEqual([`user: ${KM}`, "agent: Let me work that out.", LOAD_UNITS_ROW, "agent: Let me work that out.", CONVERT_ROW, `agent: ${CONVERTED}`])
    // The tools each of the three model calls was offered: the skill's tool from the call after the load.
    expect(offered(1)).toEqual([BASE, WITH_CONVERT, WITH_CONVERT])
    // Loading stored nothing of its own: a call and its result, as any tool's.
    expect(await names()).toEqual([
      "1 core.session.turn.started", "2 conversation.user.message", "3 conversation.assistant.message", "4 conversation.tool.result",
      "5 conversation.assistant.message", "6 conversation.tool.result", "7 conversation.assistant.message", "8 core.session.turn.ended",
    ])
    const stored = (await runtime.journal())[3]!
    expect([stored.seq, stored.name, stored.tags, stored.message]).toEqual([
      4, "conversation.tool.result", ["conversation"],
      expect.objectContaining({ _tag: "ToolResult", name: "loadSkill", isFailure: false, result: UNITS_LOADED, whole: true }),
    ])
    // The skill is loaded because that result is in the journal.
    expect(await loaded()).toEqual(["units"])
  })

  test("the Context tab, at that turn: each model call's tools, the load's result as the last row of the second prompt, and the prompt's size call by call", async () => {
    const { say, context } = await page()
    await say(KM)
    const view = viewOf(context(), 1)
    expect(view.calls.map((call) => call.call)).toEqual([1, 2, 3])
    expect(view.calls.map((call) => call.tools)).toEqual([BASE, WITH_CONVERT, WITH_CONVERT])
    // The first prompt is the system text and the message; the second ends with the instructions, read from record 4.
    const first = Option.getOrThrow(view.calls[0]!.prompt)
    expect(first.map((row) => [row.role, row.source, Option.getOrNull(row.seq), row.tokens])).toEqual([["system", "code", null, 88], ["user", "memory", 2, 7]])
    const second = Option.getOrThrow(view.calls[1]!.prompt)
    expect(second.map((row) => [row.role, row.source, Option.getOrNull(row.seq), row.tokens])).toEqual([
      ["system", "code", null, 88], ["user", "memory", 2, 7], ["assistant", "memory", 3, 15], ["tool", "memory", 4, 55],
    ])
    expect(second.at(-1)?.text).toBe(`loadSkill → ${JSON.stringify(UNITS_LOADED)}`)
    // No row says the result was cut short: the instructions are sent whole.
    expect(second.map((row) => Option.getOrNull(row.pointer))).toEqual([null, null, null, null])
    expect(view.calls.map((call) => call.promptTokens)).toEqual([95, 165, 190])
    // The third prompt ends with the skill's tool's number.
    expect(Option.getOrThrow(view.calls[2]!.prompt).at(-1)).toMatchObject({ role: "tool", text: "convert → 3.1068559611866697", source: "memory", seq: Option.some(6) })
    // "The same as the prompt before" compares messages only: the second call's line counts the whole first prompt as
    // the same, though the tools offered with it changed. It says nothing of the tool definitions.
    expect(view.calls.map((call) => call.reusedTokens)).toEqual([0, 95, 165])
    // The journal as the third call saw it: every record of the conversation is in its context but the answer still to come.
    expect(view.calls[2]!.journal.map((row) => [row.seq, row.use])).toEqual([
      [1, "not-conversation"], [2, "in-context"], [3, "in-context"], [4, "in-context"], [5, "in-context"], [6, "in-context"], [7, "later"], [8, "not-conversation"],
    ])
  })

  test("the system text ends with the catalogue, and is the same in every prompt, whatever is loaded", async () => {
    const { say, prompts, loaded } = await page()
    await say(KM, RAIN, SUM)
    expect(await loaded()).toEqual(["units", "haiku"])
    expect(prompts()).toHaveLength(7)
    expect(prompts().map((prompt) => prompt.messages[0])).toEqual(prompts().map(() => expect.objectContaining({ role: "system", text: SYSTEM })))
    // It names both skills and says nothing of which are loaded: no prompt's system text holds a word of the instructions.
    expect(SYSTEM).not.toContain("never in your head")
    expect(SYSTEM).not.toContain("three lines")
  })

  test("a skill that is instructions alone is loaded the same way and adds no tool: Echo answers in three lines, and a sum is still the calculator's", async () => {
    const { say, replies, rows, offered, loaded, names } = await page()
    await say(RAIN)
    expect(replies()).toEqual([HAIKU])
    expect(rows()).toEqual([`user: ${RAIN}`, "agent: Let me work that out.", LOAD_HAIKU_ROW, `agent: ${HAIKU}`])
    // Two model calls, offered the same tools: the haiku skill has none.
    expect(offered(1)).toEqual([BASE, BASE])
    expect(await loaded()).toEqual(["haiku"])
    // A sum loads nothing and is answered as the tool's: the three lines are for Echo's own answers.
    await say(SUM)
    expect(replies().at(-1)).toBe("The tool answered: calculator says 5.")
    expect(offered(2)).toEqual([BASE, BASE])
    expect((await names()).slice(6)).toEqual([
      "7 core.session.turn.started", "8 conversation.user.message", "9 conversation.assistant.message", "10 conversation.tool.result",
      "11 conversation.assistant.message", "12 core.session.turn.ended",
    ])
    expect(await loaded()).toEqual(["haiku"])
  })

  test("the page's own path: a length, a haiku, a sum; both skills are loaded, and every later prompt holds each load's result", async () => {
    const { say, replies, offered, loaded, prompts, rows } = await page()
    await say(KM, RAIN, SUM)
    expect(replies()).toEqual([CONVERTED, HAIKU, "The tool answered: calculator says 5."])
    expect([offered(1), offered(2), offered(3)]).toEqual([[BASE, WITH_CONVERT, WITH_CONVERT], [WITH_CONVERT, WITH_CONVERT], [WITH_CONVERT, WITH_CONVERT]])
    expect(await loaded()).toEqual(["units", "haiku"])
    // Each load's result is sent in every prompt after it, whole: the instructions stay with the conversation.
    const results = prompts().map((prompt) => prompt.messages.filter((message) => message.role === "tool" && message.text.startsWith("loadSkill → ")).map((message) => message.text))
    const units = `loadSkill → ${JSON.stringify(UNITS_LOADED)}`
    const haiku = `loadSkill → ${JSON.stringify(HAIKU_LOADED)}`
    expect(results).toEqual([[], [units], [units], [units], [units, haiku], [units, haiku], [units, haiku]])
    // The tool list changed once in the conversation, at the load that added a tool; the haiku skill's load changed none.
    const lists = prompts().map((prompt) => prompt.tools.join(","))
    expect(lists.filter((list, at) => at > 0 && list !== lists[at - 1])).toEqual([WITH_CONVERT.join(",")])
    expect(rows().filter((row) => row.startsWith("tool: loadSkill"))).toEqual([LOAD_UNITS_ROW, LOAD_HAIKU_ROW])
  })

  test("two skills loaded in one conversation are loaded in the order of their loads, not the catalogue's", async () => {
    const { say, loaded, offered, replies } = await page()
    await say(RAIN, KM)
    expect(replies()).toEqual([HAIKU, CONVERTED])
    // The catalogue lists units first; haiku was loaded first.
    expect(await loaded()).toEqual(["haiku", "units"])
    expect(offered(2)).toEqual([BASE, WITH_CONVERT, WITH_CONVERT])
  })

  test("Rebuild: the skill is still loaded, since the load's result is in the journal; Clear context: nothing is loaded", async () => {
    const { runtime, say, replies, offered, loaded, names, clear } = await page()
    await say(KM)
    expect(offered(1)).toEqual([BASE, WITH_CONVERT, WITH_CONVERT])
    // Rebuild: the program starts again over the same journal. Nothing was kept but the records.
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    expect(await loaded()).toEqual(["units"])
    await say(KM)
    expect(replies().at(-1)).toBe(CONVERTED)
    // The turn's first model call is offered convert, and the turn makes no load: two calls where the first turn took three.
    expect(offered(2)).toEqual([WITH_CONVERT, WITH_CONVERT])
    expect((await names()).slice(8)).toEqual([
      "9 core.session.turn.started", "10 conversation.user.message", "11 conversation.assistant.message", "12 conversation.tool.result",
      "13 conversation.assistant.message", "14 core.session.turn.ended",
    ])
    // Clear context: another conversation, whose journal holds no load.
    expect(await clear()).toEqual({ _tag: "Built" })
    expect(await loaded()).toEqual([])
    await say(KM)
    expect(replies().at(-1)).toBe(CONVERTED)
    expect(offered(1)).toEqual([BASE, WITH_CONVERT, WITH_CONVERT])
    expect(await loaded()).toEqual(["units"])
  })

  test("\"Load units.\" loads a skill by name, and the answer says so without the instructions", async () => {
    const { say, replies, rows, offered, loaded } = await page()
    await say("Load units.")
    expect(replies()).toEqual(["Loaded units."])
    expect(rows()).toEqual(["user: Load units.", "agent: Let me work that out.", LOAD_UNITS_ROW, "agent: Loaded units."])
    expect(offered(1)).toEqual([BASE, WITH_CONVERT])
    expect(await loaded()).toEqual(["units"])
  })

  test("a skill `skills` refuses refuses the build, in the kernel's words: no program runs, and the conversation is untouched", async () => {
    const { runtime, say, replies, names } = await page()
    await say(SUM)
    const before = await names()
    const unfit = SOURCES.skills!.replace('id: "units"', 'id: "Units"')
    expect(unfit).not.toBe(SOURCES.skills)
    expect(await runtime.start({ ...SOURCES, skills: unfit })).toEqual({
      _tag: "Refused",
      message: 'skills.ts did not run: a skill\'s id is lower-case words joined by hyphens, at most 64 characters, such as "unit-converter": "Units" is none',
    })
    expect(runtime.running).toBe(false)
    expect(await names()).toEqual(before)
    // Two skills under one name, and a tool two of them have, are refused as the file runs too.
    const twice = SOURCES.skills!.replace('id: "haiku"', 'id: "units"')
    expect(await runtime.start({ ...SOURCES, skills: twice })).toEqual({ _tag: "Refused", message: "skills.ts did not run: two skills are named units: a skill is loaded by its name" })
    const shared = SOURCES.skills!.replace("tools: Toolkit.empty", "tools: Toolkit.make(convert)")
    expect(await runtime.start({ ...SOURCES, skills: shared })).toEqual({
      _tag: "Refused", message: "skills.ts did not run: the tool convert is in the skill units and in the skill haiku: a tool belongs to one skill, or to none",
    })
    // The lesson's own file builds again, over the same conversation.
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    await say(SUM)
    expect(replies()).toEqual(["The tool answered: calculator says 5.", "The tool answered: calculator says 5."])
  })

  test("the chat drawn again from the journal shows the same rows, each load with its result", async () => {
    const { runtime, say, rows } = await page()
    await say(KM, RAIN, SUM, "Load units.")
    const redrawn = chatRowsOf(await runtime.journal()).map(told)
    expect(redrawn.filter((row) => row.startsWith("tool: loadSkill"))).toEqual([LOAD_UNITS_ROW, LOAD_HAIKU_ROW, LOAD_UNITS_ROW])
    // Every row of the live chat has a record behind it, and the journal alone gives the same rows in the same order.
    expect(rows().filter((row) => /^\w+\*/.test(row))).toEqual([])
    expect(redrawn).toEqual(rows())
  })

  test("with everything always on (an experiment), the same message takes two model calls, not three, and its first prompt is larger: 105 tokens to 95", async () => {
    const lazy = await page()
    await lazy.say(KM)
    const always = await page(applied("always-on"))
    expect(always.result).toEqual({ _tag: "Built" })
    await always.say(KM)
    expect(always.replies()).toEqual([CONVERTED])
    // Every tool from the first call, and no load: one step fewer.
    expect(always.offered(1)).toEqual([WITH_CONVERT, WITH_CONVERT])
    expect(always.rows()).toEqual([`user: ${KM}`, "agent: Let me work that out.", CONVERT_ROW, `agent: ${CONVERTED}`])
    expect(await always.loaded()).toEqual([])
    // The system text holds both skills' instructions and no catalogue, in every prompt.
    expect(always.prompts().map((prompt) => prompt.messages[0]?.text)).toEqual([`${OPENING}\n\n${UNITS_INSTRUCTIONS}\n\n${HAIKU_INSTRUCTIONS}`, `${OPENING}\n\n${UNITS_INSTRUCTIONS}\n\n${HAIKU_INSTRUCTIONS}`])
    // The same first message: the prompt's messages, in tokens, with skills loaded on demand and with everything always on.
    const tokens = (from: typeof lazy) => viewOf(from.context(), 1).calls.map((call) => call.promptTokens)
    expect(tokens(lazy)).toEqual([95, 165, 190])
    // The turn's last prompt, the one that carries convert's result: larger with the skill loaded (the catalogue, the
    // load's call and its result) than with everything always on.
    expect(tokens(always)).toEqual([105, 130])
    // Echo follows the haiku skill from a load's result only: with the instructions in the system text it answers as it always did.
    await always.say(RAIN)
    expect(always.replies().at(-1)).toBe('You said: "Write a haiku about rain.". I can also see 3 earlier messages.')
  })

  test("without the catalogue (an experiment), Echo is not told there are skills and loads none; a load asked for by name still works", async () => {
    const { result, say, replies, offered, loaded, prompts } = await page(applied("no-catalogue"))
    expect(result).toEqual({ _tag: "Built" })
    await say(KM)
    expect(replies()).toEqual(['You said: "How far is 5 km in miles?". This is the start of the conversation.'])
    // loadSkill was offered, and nothing in the prompt said what to load.
    expect(offered(1)).toEqual([BASE])
    expect(prompts().map((prompt) => prompt.messages[0]?.text)).toEqual([OPENING])
    expect(await loaded()).toEqual([])
    await say("Load units.", KM)
    expect(replies().slice(1)).toEqual(["Loaded units.", CONVERTED])
    expect([offered(2), offered(3)]).toEqual([[BASE, WITH_CONVERT], [WITH_CONVERT, WITH_CONVERT]])
    expect(await loaded()).toEqual(["units"])
  })

  test("a call of convert before its skill is loaded (the page's fill) fails as a call of an unknown tool, and the turn goes on; once loaded, the same call runs", async () => {
    expect(skillsLesson.fill).toEqual(["Use convert without loading."])
    const { together, say, replies, rows, offered, loaded, runtime } = await page()
    await together(skillsLesson.fill)
    // The toolkit the step offered holds no such tool, and says which it holds.
    expect(rows()).toEqual([
      "user: Use convert without loading.",
      "agent: Let me work that out.",
      `tool: convert({"value":5,"from":"km","to":"mi"}) failed: ${JSON.stringify(NOT_FOUND)}`,
      `agent: The tool answered: convert failed: ${JSON.stringify(NOT_FOUND)}.`,
    ])
    expect(offered(1)).toEqual([BASE, BASE])
    expect(await loaded()).toEqual([])
    expect(await outcomes(runtime)).toEqual(["Completed"])
    await say("Load units.")
    await together(skillsLesson.fill)
    expect(replies().slice(1)).toEqual(["Loaded units.", CONVERTED])
    expect(rows().slice(-2)).toEqual([CONVERT_ROW, `agent: ${CONVERTED}`])
    expect(offered(3)).toEqual([WITH_CONVERT, WITH_CONVERT])
  })

  test("with no handlers for the units skill (an experiment), the page runs the program and the load works; the call of convert fails when the tool runs", async () => {
    const { result, say, replies, failures, rows, offered, loaded, runtime } = await page(applied("no-handlers"))
    // The page runs the file as JavaScript: nothing checks what main was given until a tool runs.
    expect(result).toEqual({ _tag: "Built" })
    await say(KM)
    expect(failures()).toEqual([])
    // loadSkill has its handler, so the skill is loaded and its tool is offered.
    expect(rows().slice(0, 3)).toEqual([`user: ${KM}`, "agent: Let me work that out.", LOAD_UNITS_ROW])
    expect(offered(1)).toEqual([BASE, WITH_CONVERT, WITH_CONVERT])
    expect(await loaded()).toEqual(["units"])
    // The call is stored as a failed result, and the model reads it. Its words are the JavaScript engine's own, for
    // reading a handler that is not there, and differ from one engine to the next: what holds everywhere is that
    // the call failed, that its result is a text, and that the tool did not answer a number.
    const failed = (await runtime.journal())[5]?.message
    expect(failed).toMatchObject({ _tag: "ToolResult", name: "convert", isFailure: true })
    expect(failed?._tag === "ToolResult" ? typeof failed.result : "none").toBe("string")
    expect(rows()[4]?.startsWith('tool: convert({"value":5,"from":"km","to":"mi"}) failed: "')).toBe(true)
    expect(replies()).toHaveLength(1)
    expect(replies()[0]?.startsWith('The tool answered: convert failed: "')).toBe(true)
    // The turn completed, and the tools that have handlers still run.
    expect(await outcomes(runtime)).toEqual(["Completed"])
    await say(SUM)
    expect(replies().at(-1)).toBe("The tool answered: calculator says 5.")
  })

  test("\"Send three at once\" is one turn that loads both skills and works out a sum in one step; every experiment finds its lines", async () => {
    expect(skillsLesson.three).toEqual(["Load units.", "Load haiku.", "What is 2 + 3?"])
    expect(skillsLesson.chips).toEqual(["How far is 5 km in miles?", "Write a haiku about rain.", "What is 2 + 3?", "Load units."])
    const three = await page()
    await three.together(skillsLesson.three)
    // One answer for the three messages, from the three results.
    expect(three.replies()).toEqual(["Loaded units. Loaded haiku. The tool answered: calculator says 5."])
    expect(three.rows().slice(3)).toEqual(["agent: Let me use 3 tools.", LOAD_UNITS_ROW, LOAD_HAIKU_ROW, 'tool: calculator({"a":2,"op":"+","b":3}) → 5', "agent: Loaded units. Loaded haiku. The tool answered: calculator says 5."])
    expect(await outcomes(three.runtime)).toEqual(["Completed"])
    // Two model calls: the second is offered convert.
    expect(three.offered(1)).toEqual([BASE, WITH_CONVERT])
    expect(await three.loaded()).toEqual(["units", "haiku"])
    for (const [id, experiment] of Object.entries(skillsLesson.experiments)) {
      const source = SOURCES[experiment.file]!
      expect({ id, changed: Option.exists(experiment.apply(source), (next) => next !== source) }).toEqual({ id, changed: true })
    }
    expect(Object.keys(skillsLesson.experiments)).toEqual(["always-on", "no-catalogue", "no-handlers"])
    expect(skillsLesson.controls).toEqual({})
  })
})
