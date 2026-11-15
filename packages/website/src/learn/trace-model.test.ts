// The Context tab's model, fed the traces of real runs of lesson 1 on the
// page's runtime: the steps of a turn, which record each context message
// came from, what memory left out, the part of a prompt the one before
// shares, (lesson 8's runs) a tool's result sent as a pointer, (lesson
// 10's) the tools each model call was offered, and (lessons 4's and 11's)
// the row of sessions, built from each session's header.
import { afterEach, describe, expect, test } from "bun:test"
import { Option } from "effect"
import { toolResult, userMessage } from "@xandreed/core/kernel"
import { estimateTokens } from "@xandreed/sdk/kernel"
import { DEFAULT_AGENT } from "./lessons/your-first-agent/agent.source.ts"
import { DEFAULT_MEMORY } from "./lessons/your-first-agent/memory.source.ts"
import { withReminder, writeLastN } from "./lessons/your-first-agent/config-edit.ts"
import { yourFirstAgent } from "./lessons/your-first-agent/lesson.ts"
import { tools } from "./lessons/tools/lesson.ts"
import { pointers } from "./lessons/pointers/lesson.ts"
import { remember } from "./lessons/remember/lesson.ts"
import { skillsLesson } from "./lessons/skills/lesson.ts"
import { subAgents } from "./lessons/sub-agents/lesson.ts"
import { yourOwnPlugin } from "./lessons/your-own-plugin/lesson.ts"
import type { Lesson } from "./lesson.ts"
import { loadEcho } from "./models/mock.ts"
import { LessonRuntime } from "./runtime.ts"
import type { Trace } from "./runtime.ts"
import { emptyBoard, emptyBoards, heardBy, keptInJournal, kindOf, record, sessionRow, startedOver, turnNumbersOf, viewOf } from "./trace-model.ts"
import type { Board, Boards } from "./trace-model.ts"

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

/** Run `messages` through lesson 1 with these sources, and the board the page would have drawn from what it heard. */
const boardAfter = async (messages: ReadonlyArray<string>, sources: Record<string, string> = { agent: DEFAULT_AGENT, memory: DEFAULT_MEMORY }, lesson: Lesson = yourFirstAgent): Promise<Board> => {
  const runtime = await LessonRuntime.create(lesson)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  let board = emptyBoard(runtime.conversation)
  let replies = 0
  const done = new Promise<void>((resolve) => {
    runtime.onTrace((trace) => {
      board = record(board, trace, 0)
      // One by one: each message is sent once the one before has its answer, so each is a turn of its own.
      if (trace._tag === "Reply") {
        replies++
        if (replies === messages.length) resolve()
        else runtime.send(messages[replies]!)
      }
    })
  })
  await runtime.start(sources)
  runtime.send(messages[0]!)
  await done
  return board
}

describe("the Context tab's model", () => {
  test("a turn's seven steps are done, each pointing at the records it wrote", async () => {
    const board = await boardAfter(["hello"])
    expect(turnNumbersOf(board)).toEqual([1])
    const view = viewOf(board, 1)
    expect(view.steps.map((step) => [step.id, step.state])).toEqual([
      ["opened", "done"], ["stored-message", "done"], ["context-1", "done"], ["prompt-1", "done"], ["streamed-1", "done"], ["stored-answer-1", "done"], ["closed", "done"],
    ])
    expect(view.steps.find((step) => step.id === "stored-message")?.seqs).toEqual([2])
    expect(view.closed).toEqual(Option.some("Completed"))
    expect(view.calls.at(-1)!.journal.map((row) => [row.seq, row.name, row.tags, row.use])).toEqual([
      [1, "core.session.turn.started", ["turn"], "not-conversation"],
      [2, "conversation.user.message", ["conversation"], "in-context"],
      [3, "conversation.assistant.message", ["conversation"], "later"],
      [4, "core.session.turn.ended", ["turn"], "not-conversation"],
    ])
  })

  test("the second prompt's messages come from the records of turn 1 and its own, and its start is the first prompt", async () => {
    const view = viewOf(await boardAfter(["hello", "again"]), 2)
    expect(Option.getOrThrow(view.calls.at(-1)!.prompt).map((row) => [row.role, row.source, Option.getOrNull(row.seq), row.reused])).toEqual([
      ["system", "code", null, true],
      ["user", "memory", 2, true],
      ["assistant", "memory", 3, false],
      ["user", "memory", 6, false],
    ])
    expect(view.calls.at(-1)!.reusedTokens).toBeGreaterThan(0)
    expect(view.calls.at(-1)!.reusedTokens).toBeLessThan(view.calls.at(-1)!.promptTokens)
  })

  test("with memory keeping the last message, the older ones are left out, and only the system text is shared", async () => {
    const board = await boardAfter(["one", "two", "three"], { agent: DEFAULT_AGENT, memory: Option.getOrThrow(writeLastN(DEFAULT_MEMORY, 1)) })
    const view = viewOf(board, 3)
    expect(Option.getOrThrow(view.calls.at(-1)!.memory).map((row) => [row.text, Option.getOrNull(row.seq)])).toEqual([["three", 10]])
    expect(view.calls.at(-1)!.journal.filter((row) => row.use === "left-out").map((row) => row.seq)).toEqual([2, 3, 6, 7])
    expect(Option.getOrThrow(view.calls.at(-1)!.prompt).map((row) => row.reused)).toEqual([true, false])
    expect(view.steps.find((step) => step.id === "context-1")?.detail).toContain("4 left out by memory")
  })

  test("a message the code adds after the context is shown as added, never stored", async () => {
    const view = viewOf(await boardAfter(["hi"], { agent: Option.getOrThrow(withReminder(DEFAULT_AGENT)), memory: DEFAULT_MEMORY }), 1)
    expect(Option.getOrThrow(view.calls.at(-1)!.prompt).map((row) => row.source)).toEqual(["code", "memory", "added"])
  })

  test("a step names the line that did it: a loop written by hand, or the kernel's two functions", async () => {
    const startersOf = (lesson: Lesson) => Object.fromEntries(lesson.files.map((file) => [file.id, file.defaultText]))
    const codeOf = async (lesson: Lesson) => {
      const view = viewOf(await boardAfter(["What is 12 * 3?"], startersOf(lesson), lesson), 1)
      return ["stored-answer-1", "tools-1", "stored-answer-2"].map((id) => view.steps.find((step) => step.id === id)?.code)
    }
    // Lesson 2 writes both blocks by hand; lesson 3's loop is the base's, on modelAnswer and callTool.
    expect(await codeOf(tools)).toEqual(["session.append(assistantMessage(…))", "toolkit.handle(call.name, call.params)", "session.append(assistantMessage(…))"])
    expect(await codeOf(yourOwnPlugin)).toEqual(["modelAnswer(stream, session)", "callTool(toolkit, call, session)", "modelAnswer(stream, session)"])
  })

  test("a tool's result sent as a pointer says how many tokens of it the journal keeps; one sent as stored says nothing", async () => {
    const starters = Object.fromEntries(pointers.files.map((file) => [file.id, file.defaultText]))
    const marks = (board: Board, turn: number, call: number) => Option.getOrThrow(viewOf(board, turn).calls[call]!.prompt).map((row) => [row.role, Option.getOrNull(row.seq), Option.getOrNull(row.pointer)])
    const board = await boardAfter(["Look up tides.", "Read more."], starters, pointers)
    // The article is record 4, whole; the prompt's row for it holds a pointer, and says what the journal keeps.
    const stored = board.records.find((one) => one.seq === 4)?.message
    const article = stored?._tag === "ToolResult" && typeof stored.result === "string" ? stored.result : ""
    expect(article.length).toBe(2347)
    expect(Number(estimateTokens(article))).toBe(587)
    expect(marks(board, 1, 1)).toEqual([["system", null, null], ["user", 2, null], ["assistant", 3, null], ["tool", 4, 587]])
    // The next turn reads on: the pointer is still a pointer, and the part readResult returned is sent as it is stored.
    expect(marks(board, 2, 1)).toEqual([
      ["system", null, null], ["user", 2, null], ["assistant", 3, null], ["tool", 4, 587], ["assistant", 5, null],
      ["user", 8, null], ["assistant", 9, null], ["tool", 10, null],
    ])
    // With memory reading each record as stored, the same result is no pointer.
    const whole = await boardAfter(["Look up tides."], { ...starters, memory: Option.getOrThrow(pointers.experiments["no-pointers"]!.apply(starters.memory!)) }, pointers)
    expect(marks(whole, 1, 1)).toEqual([["system", null, null], ["user", 2, null], ["assistant", 3, null], ["tool", 4, null]])
  })

  test("a tool's result sent another way than in the prompt before is not the same as the prompt before, nor is anything after it", async () => {
    const starters = Object.fromEntries(pointers.files.map((file) => [file.id, file.defaultText]))
    const same = (board: Board) => Option.getOrThrow(viewOf(board, 2).calls[0]!.prompt).map((row) => [row.role, row.reused])
    // A memory that sends a result whole in its own turn and as a pointer afterwards: the row answers the same call, and holds other text.
    const older = await boardAfter(["Look up tides.", "Thanks."], { ...starters, memory: Option.getOrThrow(pointers.experiments["older-turns"]!.apply(starters.memory!)) }, pointers)
    expect(same(older)).toEqual([["system", true], ["user", true], ["assistant", true], ["tool", false], ["assistant", false], ["user", false]])
    // Sent the same way in both turns, the row is the prompt before's, and so is everything up to that prompt's end.
    expect(same(await boardAfter(["Look up tides.", "Thanks."], starters, pointers))).toEqual([["system", true], ["user", true], ["assistant", true], ["tool", true], ["assistant", false], ["user", false]])
  })

  test("each model call's tools are those its own prompt was offered, in order: a skill's tool from the call after the load (lesson 10)", async () => {
    const starters = Object.fromEntries(skillsLesson.files.map((file) => [file.id, file.defaultText]))
    const board = await boardAfter(["How far is 5 km in miles?", "What is 2 + 3?"], starters, skillsLesson)
    const base = ["calculator", "remember", "recall", "loadSkill"]
    // Turn 1 loads the units skill at its first call: the second and third calls are offered its tool, after the others.
    expect(viewOf(board, 1).calls.map((call) => [call.call, call.tools])).toEqual([[1, base], [2, [...base, "convert"]], [3, [...base, "convert"]]])
    // The next turn's calls are offered it from the first.
    expect(viewOf(board, 2).calls.map((call) => call.tools)).toEqual([[...base, "convert"], [...base, "convert"]])
    // The events log says how many, call by call.
    expect(board.log.filter((entry) => entry.kind === "prompt").map((entry) => [entry.turn, /, (\d+) tools offered$/.exec(entry.title)?.[1]])).toEqual([[1, "4"], [1, "5"], [1, "5"], [2, "5"], [2, "5"]])
    // A program that offers no tools has none to list.
    expect(viewOf(await boardAfter(["hello"]), 1).calls.map((call) => call.tools)).toEqual([[]])
  })

  test("what was sent is compared with what is stored, by the call it answers: no words of a pointer are looked for", () => {
    const stored = toolResult({ id: "c1", name: "lookup" }, "x".repeat(1000))
    const said = (text: string, resultId = "c1") => ({ role: "tool", text, key: `result:${resultId}`, resultId })
    // Sent as stored: nothing to say.
    expect(keptInJournal(said(`lookup → ${JSON.stringify("x".repeat(1000))}`), stored)).toEqual(Option.none())
    // Sent as anything else, a pointer's words or not: the stored result's estimate.
    expect(keptInJournal(said('lookup → "xxxx"'), stored)).toEqual(Option.some(250))
    // A result that answers another call, and a record that holds no tool result, are not compared.
    expect(keptInJournal(said('lookup → "xxxx"', "c2"), stored)).toEqual(Option.none())
    expect(keptInJournal(said('lookup → "xxxx"'), userMessage("hi"))).toEqual(Option.none())
  })

  test("events of another conversation are not on the board", () => {
    const board = record(emptyBoard("mine"), { _tag: "Event", event: { _tag: "Live", session: "other" as never, name: "x.y" as never, tags: [], data: null } }, 0)
    expect(board.log).toEqual([])
  })
})

/**
 * Run `messages` through a lesson, one a turn, and what the page would hold of it: every trace, and the boards the
 * Context tab folds them into, one per session.
 */
const boardsAfter = async (lesson: Lesson, messages: ReadonlyArray<string>, sources: Record<string, string> = Object.fromEntries(lesson.files.map((file) => [file.id, file.defaultText]))) => {
  const runtime = await LessonRuntime.create(lesson)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<Trace> = []
  runtime.onTrace((trace) => heard.push(trace))
  expect(await runtime.start(sources)).toEqual({ _tag: "Built" })
  for (const message of messages) {
    const answered = new Promise<void>((resolve) => { const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply" || trace._tag === "Failed" || trace._tag === "Ended") { stop(); resolve() } }) })
    runtime.send(message)
    await answered
  }
  const all = heard.reduce<Boards>((built, trace) => heardBy(built, trace, 0), emptyBoards(runtime.conversation))
  return { runtime, heard, all }
}

/** The row as a test reads it: each button's kind and label. */
const labels = (all: Boards) => sessionRow(all).map((tab) => `${tab.kind}: ${tab.label}`)

describe("the Context tab's row of sessions", () => {
  test("a session is what its header says: the chat's, a helper's (it has a parent), the memory session (the facts plugin's, with no parent), or another", () => {
    const header = (owner: string, parent?: string) => Option.some({ owner, parent: Option.fromNullishOr(parent) })
    expect(kindOf("chat", "chat", header("learner"))).toBe("chat")
    expect(kindOf("s1", "chat", header("helper", "chat"))).toBe("helper")
    expect(kindOf("s1", "chat", header("anything", "s0"))).toBe("helper")
    expect(kindOf("s1", "chat", header("plugin.facts"))).toBe("memory")
    // The memory session continues no other, as the kernel finds it: one the plugin owns under a parent is a child.
    expect(kindOf("s1", "chat", header("plugin.facts", "chat"))).toBe("helper")
    // An earlier conversation, or any session of the program's own making, is no helper: it has no parent.
    expect(kindOf("s1", "chat", header("learner"))).toBe("other")
    // A header that was never heard says nothing: the session is not taken for a helper.
    expect(kindOf("s1", "chat", Option.none())).toBe("other")
  })

  test("lesson 4: each helper is a button named by its number among the helpers and its task, a child of the chat's; the chat reads as before", async () => {
    const { runtime, heard, all } = await boardsAfter(subAgents, ["Ask a helper: what is 6 * 7?", "Have a helper work out 120 / 8."])
    const chat = runtime.conversation
    // The page was told of each helper's session once, before that session's first record.
    const named = heard.flatMap((trace) => (trace._tag === "Session" ? [trace] : []))
    expect(named.map((trace) => [trace.owner, trace.parent])).toEqual([["helper", chat], ["helper", chat]])
    for (const trace of named) {
      const first = heard.findIndex((one) => one._tag === "Event" && one.event.session === trace.session)
      expect(heard.indexOf(trace)).toBeLessThan(first)
    }
    expect(heard.some((trace) => trace._tag === "Session" && trace.session === chat)).toBe(false)
    const [first, second] = named.map((trace) => trace.session)
    expect<unknown>(sessionRow(all)).toEqual([
      { session: chat, kind: "chat", label: "Chat", title: "The chat's session" },
      { session: first, kind: "helper", label: "Helper 1: what is 6 * 7?", title: `A helper's session, a child of the chat's: ${first}` },
      { session: second, kind: "helper", label: "Helper 2: work out 120 / 8.", title: `A helper's session, a child of the chat's: ${second}` },
    ])
    // The helper's board reads as it did: its turn is opened by its caller, and its words stay out of the chat.
    const helper = viewOf(all.boards.get(first!)!, 1)
    expect(helper.steps.map((step) => step.id)).toEqual(["opened", "stored-message", "context-1", "prompt-1", "streamed-1", "stored-answer-1", "tools-1", "context-2", "prompt-2", "streamed-2", "stored-answer-2", "closed"])
    expect(helper.steps.find((step) => step.id === "opened")?.code).toBe("sessions.open(session)")
    expect(helper.steps.find((step) => step.id === "streamed-1")).toMatchObject({ code: "hooks.stream (quiet)", detail: "A helper's hooks keep its words out of the chat: its answer goes back to its caller as delegate's result." })
    expect(viewOf(all.boards.get(chat)!, 1).steps.find((step) => step.id === "opened")?.code).toBe("sessions.open(chat.session)")
  })

  test("lesson 4, a turn in a session of the program's own making: that session is no helper, and its helper is a child of another session's", async () => {
    const sources = Object.fromEntries(subAgents.files.map((file) => [file.id, file.defaultText]))
    const elsewhere = sources.agent!.replace(
      "        const session = yield* sessions.open(chat.session)\n",
      "        const session = yield* sessions.open(yield* sessions.create({ owner: \"another\" }))\n",
    )
    expect(elsewhere).not.toBe(sources.agent)
    const { runtime, heard, all } = await boardsAfter(subAgents, ["Ask a helper: what is 6 * 7?"], { ...sources, agent: elsewhere })
    const [own, helper] = heard.flatMap((trace) => (trace._tag === "Session" ? [trace.session] : []))
    expect<unknown>(sessionRow(all)).toEqual([
      { session: runtime.conversation, kind: "chat", label: "Chat", title: "The chat's session" },
      { session: own, kind: "other", label: "Session 1: Ask a helper: what is 6 * 7?", title: `A session of the program's own, owned by another: ${own}` },
      { session: helper, kind: "helper", label: "Helper 1: what is 6 * 7?", title: `A helper's session, a child of another session's: ${helper}` },
    ])
    expect(viewOf(all.boards.get(own!)!, 1).steps.find((step) => step.id === "streamed-1")?.detail).toBe("This session is not the chat's: what its model says is not drawn in the chat.")
  })

  test("a session whose header was never heard is not called a helper", async () => {
    const { runtime, heard } = await boardsAfter(subAgents, ["Ask a helper: what is 6 * 7?"])
    const unnamed = heard.filter((trace) => trace._tag !== "Session").reduce<Boards>((built, trace) => heardBy(built, trace, 0), emptyBoards(runtime.conversation))
    expect(labels(unnamed)).toEqual(["chat: Chat", "other: Session 1: what is 6 * 7?"])
    expect(sessionRow(unnamed)[1]?.title.startsWith("A session of the program's own: ")).toBe(true)
  })

  test("lesson 11: the memory session is a button of its own, \"Memory\", whose title says it holds the facts; it is no helper, and no helper is in the row", async () => {
    const { runtime, heard, all } = await boardsAfter(remember, ["My name is Ana.", "What is 2 + 3?"])
    const named = heard.flatMap((trace) => (trace._tag === "Session" ? [trace] : []))
    expect(named.map((trace) => [trace.owner, trace.parent])).toEqual([["plugin.facts", undefined]])
    const memory = named[0]!.session
    expect(sessionRow(all)).toEqual([
      { session: runtime.conversation, kind: "chat", label: "Chat", title: "The chat's session" },
      { session: memory, kind: "memory", label: "Memory", title: `The memory session: it holds the facts the agent remembers, in a journal of its own, for every conversation: ${memory}` },
    ])
    // The same traces without the header: the page would not know what the session is, and still calls it no helper.
    const unnamed = heard.filter((trace) => trace._tag !== "Session").reduce<Boards>((built, trace) => heardBy(built, trace, 0), emptyBoards(runtime.conversation))
    expect(labels(unnamed)).toEqual(["chat: Chat", "other: Session 1"])
  })

  test("a turn on the memory session is three steps and no model call; the fact's row says where it came from, and its payload holds the conversation and the turn", async () => {
    const { runtime, all } = await boardsAfter(remember, ["My name is Ana."])
    const chat = runtime.conversation
    const memory = [...all.boards.values()].find((board) => board.kind === "memory")!
    expect(turnNumbersOf(memory)).toEqual([1])
    const view = viewOf(memory, 1)
    expect(view.closed).toEqual(Option.some("Completed"))
    expect(view.steps.map((step) => [step.id, step.label, step.state, step.code, step.seqs])).toEqual([
      ["opened", "Turn opened", "done", "sessions.turn(yield* memorySession, …)", [1]],
      ["stored-record-1", "Fact learned", "done", "session.append(…)", [2]],
      ["closed", "Turn closed", "done", "the scope ends", [3]],
    ])
    expect(view.steps[0]?.detail).toBe("Record #1, core.session.turn.started. A call of rememberFact or forgetFact is one turn on the memory session, opened while the conversation's own turn is open.")
    expect(view.steps[1]?.detail).toBe(`Record #2, plugin.facts.learned. Open it in the Journal column to read all of it. In short: fact f1, from turn 1 of conversation ${chat.slice(0, 8)}: The user's name is Ana.`)
    // No memory built a context from this journal, and no prompt was sent in it.
    expect(view.calls).toHaveLength(1)
    expect([view.calls[0]?.memory, view.calls[0]?.prompt]).toEqual([Option.none(), Option.none()])
    expect(view.calls[0]?.journal.map((row) => [row.seq, row.name, row.tags, row.use, row.summary])).toEqual([
      [1, "core.session.turn.started", ["turn"], "not-conversation", "turn 1 opened"],
      [2, "plugin.facts.learned", ["memory"], "fact", `fact f1, from turn 1 of conversation ${chat.slice(0, 8)}: The user's name is Ana.`],
      [3, "core.session.turn.ended", ["turn"], "not-conversation", "turn 1 closed: Completed"],
    ])
    // The record opened: the fact, and the conversation and turn it came from, whole.
    expect(view.calls[0]?.journal[1]?.payload).toBe(JSON.stringify({ id: "f1", text: "The user's name is Ana.", from: { session: chat, turn: 1 } }, null, 2))
    // The chat's board holds no record of the fact: the call, and the id.
    expect(all.boards.get(chat)!.records.map((one) => String(one.name))).toEqual([
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "conversation.tool.result", "conversation.assistant.message", "core.session.turn.ended",
    ])
  })

  test("a forgotten fact is a step and a row of its own in the memory session", async () => {
    const { all } = await boardsAfter(remember, ["My name is Ana.", "Forget my name."])
    const memory = [...all.boards.values()].find((board) => board.kind === "memory")!
    expect(turnNumbersOf(memory)).toEqual([1, 2])
    const view = viewOf(memory, 2)
    expect(view.steps.map((step) => [step.id, step.label, step.seqs])).toEqual([["opened", "Turn opened", [4]], ["stored-record-1", "Fact forgotten", [5]], ["closed", "Turn closed", [6]]])
    expect(view.calls[0]?.journal.map((row) => [row.seq, row.use, row.summary, row.ofTurn])).toEqual([
      [1, "not-conversation", "turn 1 opened", false], [2, "fact", expect.stringContaining("fact f1, from turn 1 of conversation "), false], [3, "not-conversation", "turn 1 closed: Completed", false],
      [4, "not-conversation", "turn 2 opened", true], [5, "fact", "fact f1 no longer stands", true], [6, "not-conversation", "turn 2 closed: Completed", true],
    ])
  })

  test("a new conversation keeps the memory session's board, with its records, and retires every other session with the old chat's", async () => {
    // Lesson 11: the memory session is not the old conversation's.
    const facts = await boardsAfter(remember, ["My name is Ana."])
    const memory = [...facts.all.boards.values()].find((board) => board.kind === "memory")!
    const next = startedOver(facts.all, "the-next-conversation")
    expect(labels(next)).toEqual(["chat: Chat", "memory: Memory"])
    expect(next.boards.get("the-next-conversation")).toEqual(emptyBoard("the-next-conversation"))
    expect(next.boards.get(memory.session)).toBe(memory)
    expect([...next.retired]).toEqual([facts.runtime.conversation])
    // The memory session is not retired: what it announces from here on is still filed under its board.
    expect(next.retired.has(memory.session)).toBe(false)
    // Lesson 4: a helper's session is the old conversation's, and goes with it; what it still says is passed over.
    const helped = await boardsAfter(subAgents, ["Ask a helper: what is 6 * 7?"])
    const cleared = startedOver(helped.all, "the-next-conversation")
    expect(labels(cleared)).toEqual(["chat: Chat"])
    expect(cleared.retired.size).toBe(2)
    const ofRetired = helped.heard.filter((trace) => (trace._tag === "Event" && cleared.retired.has(trace.event.session))
      || ((trace._tag === "Context" || trace._tag === "Prompt" || trace._tag === "Usage" || trace._tag === "Session") && cleared.retired.has(trace.session)))
    expect(ofRetired.length).toBeGreaterThan(20)
    expect(ofRetired.reduce<Boards>((built, trace) => heardBy(built, trace, 0), cleared)).toBe(cleared)
  })
})
