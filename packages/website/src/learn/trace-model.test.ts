// The Context tab's model, fed the traces of real runs of lesson 1 on the
// page's runtime: the steps of a turn, which record each context message
// came from, what memory left out, and the part of a prompt the one before
// shares.
import { afterEach, describe, expect, test } from "bun:test"
import { Option } from "effect"
import { DEFAULT_AGENT } from "./lessons/your-first-agent/agent.source.ts"
import { DEFAULT_MEMORY } from "./lessons/your-first-agent/memory.source.ts"
import { withReminder, writeLastN } from "./lessons/your-first-agent/config-edit.ts"
import { yourFirstAgent } from "./lessons/your-first-agent/lesson.ts"
import { loadEcho } from "./models/mock.ts"
import { LessonRuntime } from "./runtime.ts"
import { emptyBoard, record, turnsOf, viewOf } from "./trace-model.ts"
import type { Board } from "./trace-model.ts"

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

/** Run `messages` through lesson 1 with these sources, and the board the page would have drawn from what it heard. */
const boardAfter = async (messages: ReadonlyArray<string>, sources = { agent: DEFAULT_AGENT, memory: DEFAULT_MEMORY }): Promise<Board> => {
  const runtime = await LessonRuntime.create(yourFirstAgent)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  let board = emptyBoard(runtime.conversation)
  let replies = 0
  const done = new Promise<void>((resolve) => {
    runtime.onTrace((trace) => {
      board = record(board, trace, 0)
      if (trace._tag === "Reply" && ++replies === messages.length) resolve()
    })
  })
  await runtime.start(sources)
  messages.forEach((text) => runtime.send(text))
  await done
  return board
}

describe("the Context tab's model", () => {
  test("a turn's seven steps are done, each pointing at the records it wrote", async () => {
    const board = await boardAfter(["hello"])
    expect(turnsOf(board)).toEqual([1])
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

  test("events of another conversation are not on the board", () => {
    const board = record(emptyBoard("mine"), { _tag: "Event", event: { _tag: "Live", session: "other" as never, name: "x.y" as never, tags: [], data: null } }, 0)
    expect(board.log).toEqual([])
  })
})
