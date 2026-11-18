import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { assistantMessage, Seq, SessionId, stored, toolResult, turnEndedEvent, TurnNumber, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import type { StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import { taskReport } from "../task/task.entity.functions.js"
import { TaskId } from "../task/task.entity.js"
import { turnsOf } from "../turn/turns.entity.functions.js"
import { SOURCE_LIMIT, TURN_MESSAGE_SHOWN, TURN_RESULT_SHOWN } from "./knowledge.entity.js"
import type { TurnSource } from "./knowledge.entity.js"
import { turnSource } from "./knowledge-source.entity.functions.js"

/** A journal from drafts, each with the turn it is stored in: places count from one. */
const journalOf = (...records: ReadonlyArray<readonly [turn: number, draft: StoredDraft]>): ReadonlyArray<StoredEvent> =>
  records.map(([turn, draft], index) => ({ ...draft, seq: Seq.make(index + 1), at: 1_767_225_600_000, turn: TurnNumber.make(turn) }))

const started = (turn: number) => stored(turnStartedEvent, { turn: TurnNumber.make(turn) })
const closed = (turn: number) => stored(turnEndedEvent, { turn: TurnNumber.make(turn), outcome: { _tag: "Completed" } })
const calls = (text: string, ...made: ReadonlyArray<readonly [id: string, name: string, params: unknown]>) =>
  assistantMessage(text, { toolCalls: made.map(([id, name, params]) => ({ id, name, params })) })
const result = (id: string, name: string, value: unknown, isFailure = false) => toolResult({ id, name }, value, isFailure)

/** One turn of a question and an answer, as its records. */
const plain = (turn: number, question: string, answer: string): ReadonlyArray<readonly [number, StoredDraft]> =>
  [[turn, started(turn)], [turn, userMessage(question)], [turn, assistantMessage(answer)], [turn, closed(turn)]]

/** A source's parts, each as who said it and its text, a tool's call in brackets before what it returned. */
const said = (source: Option.Option<TurnSource>) => Option.match(source, {
  onNone: () => [],
  onSome: (one) => one.said.map((part) => `${part.by}: ${part.by === "tool" && part.call !== undefined ? `[${part.call.text}${part.call.failed ? ", failed" : ""}] ` : ""}${part.text}`),
})

describe("a turn as a source", () => {
  const journal = journalOf(
    ...plain(1, "My friend Ana Silva works at Acme.", "Good to know."),
    ...plain(2, "She just got a second parrot, called Kiwi.", "Two parrots!"),
    ...plain(3, "ok cool", "Anything else?"),
    [4, started(4)], [4, userMessage("Can you look up the status of my order QX-77120?")],
    [4, calls("One moment.", ["c1", "lookupOrder", { order: "QX-77120" }], ["c2", "recallMemory", { query: "order" }], ["c3", "search", { query: "DHL" }])],
    [4, result("c1", "lookupOrder", { status: "shipped", carrier: "DHL" })], [4, result("c2", "recallMemory", "m3: The user has an order.")], [4, result("c3", "search", "The service is down.", true)],
    [4, assistantMessage("Your order QX-77120 has shipped with DHL.")], [4, closed(4)],
  )
  const turns = turnsOf(journal)

  test("the turn's parts are each message of the user's, each tool call with its result, and the final answer, labelled in the text", () => {
    const source = turnSource(turns, 4)
    // A tool's part is what the tool returned; the call the model wrote is beside it, and is no part of its text.
    expect(said(source)).toEqual([
      "user: Can you look up the status of my order QX-77120?",
      `tool: [lookupOrder, called with {"order":"QX-77120"}] {"status":"shipped","carrier":"DHL"}`,
      `tool: [recallMemory, called with {"query":"order"}] m3: The user has an order.`,
      `tool: [search, called with {"query":"DHL"}, failed] The service is down.`,
      "assistant: Your order QX-77120 has shipped with DHL.",
    ])
    expect(Option.map(source, (one) => one.text)).toEqual(Option.some([
      "User: Can you look up the status of my order QX-77120?",
      `Tool lookupOrder, called with {"order":"QX-77120"}, returned: {"status":"shipped","carrier":"DHL"}`,
      `Tool recallMemory, called with {"query":"order"}, returned: m3: The user has an order.`,
      `Tool search, called with {"query":"DHL"}, failed: The service is down.`,
      "Assistant's final answer: Your order QX-77120 has shipped with DHL.",
    ].join("\n")))
  })

  test("the context is the two turns before it: the user's messages and the final answers only", () => {
    expect(Option.map(turnSource(turns, 4), (one) => one.context)).toEqual(Option.some([
      "User: She just got a second parrot, called Kiwi.", "Assistant's final answer: Two parrots!",
      "User: ok cool", "Assistant's final answer: Anything else?",
    ].join("\n")))
    expect(Option.map(turnSource(turns, 2), (one) => one.context)).toEqual(Option.some("User: My friend Ana Silva works at Acme.\nAssistant's final answer: Good to know."))
    expect(Option.map(turnSource(turns, 1), (one) => one.context)).toEqual(Option.some(""))
    // A tool's call and result of an earlier turn are no part of the context.
    const after = turnsOf([...journal, ...journalOf(...plain(5, "Thanks.", "You are welcome."))])
    expect(Option.map(turnSource(after, 5), (one) => one.context)).toEqual(Option.some([
      "User: ok cool", "Assistant's final answer: Anything else?",
      "User: Can you look up the status of my order QX-77120?", "Assistant's final answer: Your order QX-77120 has shipped with DHL.",
    ].join("\n")))
  })

  test("the calls of a tool named in `leave` are left out", () => {
    expect(said(turnSource(turns, 4, { leave: ["recallMemory", "search"] }))).toEqual([
      "user: Can you look up the status of my order QX-77120?",
      `tool: [lookupOrder, called with {"order":"QX-77120"}] {"status":"shipped","carrier":"DHL"}`,
      "assistant: Your order QX-77120 has shipped with DHL.",
    ])
  })

  test("a turn that is not among them, and a turn in which the person said nothing, give no source", () => {
    expect(turnSource(turns, 9)).toEqual(Option.none())
    expect(turnSource([], 1)).toEqual(Option.none())
    const report = taskReport({ task: TaskId.make("t1"), parent: SessionId.make("c1"), session: SessionId.make("c2"), outcome: "Finished", text: "The report is done." })
    const reported = turnsOf(journalOf([1, started(1)], [1, report], [1, assistantMessage("Your report is ready.")], [1, closed(1)], [2, started(2)], [2, userMessage("   ")], [2, assistantMessage("Yes?")], [2, closed(2)]))
    expect(turnSource(reported, 1)).toEqual(Option.none())
    expect(turnSource(reported, 2)).toEqual(Option.none())
  })

  test("a call with no result is left out, and a turn that ended on a call has no answer part", () => {
    const open = turnsOf(journalOf([1, started(1)], [1, userMessage("Look it up.")], [1, calls("", ["c1", "search", { query: "x" }])]))
    expect(said(turnSource(open, 1))).toEqual(["user: Look it up."])
  })

  test("each part is bounded on its own, with what was cut counted, so a long tool result never cuts the user's words or the answer off", () => {
    const long = turnsOf(journalOf(
      [1, started(1)], [1, userMessage(`Summarise this: ${"u".repeat(9_000)}`)],
      [1, calls("", ["c1", "readFile", { path: "notes.md" }])], [1, result("c1", "readFile", "r".repeat(50_000))],
      [1, assistantMessage(`Here it is. ${"a".repeat(9_000)}`)], [1, closed(1)],
    ))
    const source = Option.getOrThrow(turnSource(long, 1))
    const [user, tool, answer] = source.said
    expect(user?.text).toHaveLength(TURN_MESSAGE_SHOWN)
    expect(user?.text.startsWith("Summarise this: uuu")).toBe(true)
    expect(user?.text.endsWith("\n[… 1044 characters clipped]")).toBe(true)
    expect(tool?.text.startsWith("rrr")).toBe(true)
    expect(tool?.text.endsWith("\n[… 46029 characters clipped]")).toBe(true)
    expect(tool?.text).toHaveLength(TURN_RESULT_SHOWN)
    expect(tool).toHaveProperty("call", { text: `readFile, called with {"path":"notes.md"}`, failed: false })
    expect(answer?.text.startsWith("Here it is. aaa")).toBe(true)
    expect(answer?.text.endsWith("\n[… 1040 characters clipped]")).toBe(true)
    expect(source.text.length).toBeLessThanOrEqual(SOURCE_LIMIT)
  })

  test("a tool call's long parameters are cut as its result is, so the call stays in the source", () => {
    const written = turnsOf(journalOf(
      [1, started(1)], [1, userMessage("Save my notes.")],
      [1, calls("", ["c1", "writeNotes", { text: "n".repeat(60_000) }])], [1, result("c1", "writeNotes", "Saved.")],
      [1, assistantMessage("Saved.")], [1, closed(1)],
    ))
    const source = Option.getOrThrow(turnSource(written, 1))
    expect(source.said.map((part) => part.by)).toEqual(["user", "tool", "assistant"])
    const line = source.text.split("\nAssistant's final answer: ")[0]?.slice("User: Save my notes.\n".length) ?? ""
    expect(line.startsWith(`Tool writeNotes, called with {"text":"nnn`)).toBe(true)
    expect(line.endsWith("\n[… 56040 characters clipped], returned: Saved.")).toBe(true)
    expect(line).toHaveLength("Tool writeNotes, called with ".length + TURN_RESULT_SHOWN + ", returned: Saved.".length)
  })

  test("while the whole is over the limit, tool calls are left out, the oldest first, and the user's words and the answer stay", () => {
    const many = turnsOf(journalOf(
      [1, started(1)], [1, userMessage("Read all six files.")],
      [1, calls("", ...Array.from({ length: 6 }, (_, at): readonly [string, string, unknown] => [`c${at}`, "readFile", { path: `file-${at}.md` }]))],
      ...Array.from({ length: 6 }, (_, at): readonly [number, StoredDraft] => [1, result(`c${at}`, "readFile", String(at).repeat(5_000))]),
      [1, assistantMessage("All read.")], [1, closed(1)],
    ))
    const source = Option.getOrThrow(turnSource(many, 1))
    // Six results of 4,000 characters each are 24,000 and more: the oldest is left out, and five fit.
    expect(said(Option.some(source)).map((part) => part.slice(0, 52))).toEqual([
      "user: Read all six files.",
      ...[1, 2, 3, 4, 5].map((at) => `tool: [readFile, called with {"path":"file-${at}.md"}] ${at}`),
      "assistant: All read.",
    ])
    expect(source.text.length).toBeLessThanOrEqual(SOURCE_LIMIT)
  })

  test("when the user's messages alone are too long, each is cut shorter until the whole fits", () => {
    const wordy = turnsOf(journalOf(
      [1, started(1)], [1, userMessage("a".repeat(9_000))], [1, userMessage("b".repeat(9_000))], [1, userMessage("c".repeat(9_000))],
      [1, calls("", ["c1", "search", { query: "x" }])], [1, result("c1", "search", "found")],
      [1, assistantMessage("d".repeat(9_000))], [1, closed(1)],
    ))
    const source = Option.getOrThrow(turnSource(wordy, 1))
    expect(source.said.map((part) => [part.by, part.text[0], part.text.length])).toEqual([["user", "a", 4_000], ["user", "b", 4_000], ["user", "c", 4_000], ["assistant", "d", 8_000]])
    expect(source.text.length).toBeLessThanOrEqual(SOURCE_LIMIT)
  })
})
