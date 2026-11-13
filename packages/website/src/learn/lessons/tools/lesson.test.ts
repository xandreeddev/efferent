// Lesson 2 on the page's runtime, with Echo: a sum through the calculator,
// a note kept by the tools, a failure the model reads, a message that steers
// a slow turn, and every experiment and control finding its line.
import { afterEach, describe, expect, test } from "bun:test"
import { Option } from "effect"
import { toolResultEvent, turnEndedEvent, userMessageEvent } from "@xandreed/core/kernel"
import { loadEcho } from "../../models/mock.ts"
import { LessonRuntime } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { DEFAULT_AGENT } from "./agent.source.ts"
import { DEFAULT_MEMORY } from "./memory.source.ts"
import { DEFAULT_TOOLS } from "./tools.source.ts"
import { tools } from "./lesson.ts"
import { emptyBoard, record, viewOf } from "../../trace-model.ts"

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES = { agent: DEFAULT_AGENT, tools: DEFAULT_TOOLS, memory: DEFAULT_MEMORY }

const start = async (sources: Record<string, string> = SOURCES) => {
  const runtime = await LessonRuntime.create(tools)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<Trace> = []
  runtime.onTrace((trace) => heard.push(trace))
  expect(await runtime.start(sources)).toEqual({ _tag: "Built" })
  return { runtime, heard }
}

const until = (runtime: LessonRuntime, match: (trace: Trace) => boolean, count = 1) => new Promise<void>((resolve) => {
  let seen = 0
  const stop = runtime.onTrace((trace) => { if (match(trace) && ++seen >= count) { stop(); resolve() } })
})
const replies = (runtime: LessonRuntime, count = 1) => until(runtime, (trace) => trace._tag === "Reply" || trace._tag === "Failed", count)
const replyTexts = (heard: ReadonlyArray<Trace>) => heard.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))
const named = async (runtime: LessonRuntime, name: string) => (await runtime.journal()).filter((record) => record.name === name)
const apply = (id: string, source: string) => Option.getOrThrow(tools.experiments[id]!.apply(source))

describe("lesson 2 on the page (the kernel, Echo)", () => {
  test("a sum goes to the calculator, its result is stored, and Echo answers from it", async () => {
    const { runtime, heard } = await start()
    const done = replies(runtime)
    runtime.send("What is 6 * 7?")
    await done
    expect(replyTexts(heard)).toEqual(["The tool answered: calculator says 42."])
    expect((await named(runtime, toolResultEvent.name)).map((record) => record.message)).toEqual([
      { _tag: "ToolResult", id: expect.stringMatching(/^echo-call-/), name: "calculator", result: 42, isFailure: false },
    ])
    // Two model calls in one turn: the page heard two prompts.
    expect(heard.filter((trace) => trace._tag === "Prompt").map((trace) => trace._tag === "Prompt" ? trace.turn : 0)).toEqual([1, 1])
  })

  test("a note kept by remember is read back by recall in the next turn", async () => {
    const { runtime, heard } = await start()
    const first = replies(runtime)
    runtime.send("Remember to buy milk.")
    await first
    const second = replies(runtime)
    runtime.send("What are my notes?")
    await second
    expect(replyTexts(heard)).toEqual(["The tool answered: remember says \"Saved. 1 notes so far.\".", "The tool answered: recall says [\"to buy milk.\"]."])
  })

  test("a failure is an answer: dividing by zero, and a broken calculator", async () => {
    const { runtime, heard } = await start()
    const first = replies(runtime)
    runtime.send("What is 1 / 0?")
    await first
    expect(replyTexts(heard)).toEqual(["The tool answered: calculator failed: \"cannot divide by zero\"."])
    expect(await runtime.start({ ...SOURCES, tools: apply("broken-calculator", DEFAULT_TOOLS) })).toEqual({ _tag: "Built" })
    const second = replies(runtime)
    runtime.send("What is 2 + 2?")
    await second
    expect(replyTexts(heard)[1]).toBe("The tool answered: calculator failed: \"the calculator is out of order\".")
  })

  test("a message sent while a slow tool runs joins the turn; without steering it waits for its own", async () => {
    const slow = { ...SOURCES, tools: apply("slow-calculator", DEFAULT_TOOLS) }
    for (const [agent, turns] of [[DEFAULT_AGENT, 1], [apply("no-steering", DEFAULT_AGENT), 2]] as const) {
      const { runtime, heard } = await start({ ...slow, agent })
      const running = until(runtime, (trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
      const done = replies(runtime, turns)
      runtime.send("What is 6 * 7?")
      await running
      runtime.send("Also, what is 10 / 4?")
      await done
      const ends = await named(runtime, turnEndedEvent.name)
      expect(ends).toHaveLength(turns)
      expect((await named(runtime, userMessageEvent.name)).map((record) => Number(record.turn))).toEqual(turns === 1 ? [1, 1] : [1, 2])
      expect(replyTexts(heard)).toHaveLength(turns)
      await runtime.dispose()
    }
  }, 30_000)

  test("one step: the turn stops after the model's first call, the call's result stored", async () => {
    const { runtime, heard } = await start({ ...SOURCES, agent: apply("one-step", DEFAULT_AGENT) })
    const done = replies(runtime)
    runtime.send("What is 2 + 2?")
    await done
    expect(replyTexts(heard)).toEqual(["I stopped after 1 steps."])
    expect(await named(runtime, toolResultEvent.name)).toHaveLength(1)
  })

  test("send three at once: the two sent while the first runs its tool join that turn, and Echo answers all three", async () => {
    const { runtime, heard } = await start()
    const done = replies(runtime)
    tools.three.forEach((text) => runtime.send(text))
    await done
    expect(await named(runtime, turnEndedEvent.name)).toHaveLength(1)
    const reply = replyTexts(heard)[0] ?? ""
    expect(reply).toContain("calculator says 36")
    expect(reply).toContain("recall says")
  })

  test("Stop while a tool runs: the call stays unanswered in the journal, and the next turn sends nothing of it", async () => {
    const { runtime, heard } = await start({ ...SOURCES, tools: apply("slow-calculator", DEFAULT_TOOLS) })
    const running = until(runtime, (trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
    runtime.send("What is 6 * 7?")
    await running
    expect((await runtime.stop()).result).toEqual({ _tag: "Built" })
    const done = replies(runtime)
    runtime.send("Hello again.")
    await done
    const journal = await runtime.journal()
    expect(journal.filter((record) => record.name === turnEndedEvent.name).map((record) => (record.data as { readonly outcome: { readonly _tag: string } }).outcome._tag)).toEqual(["Interrupted", "Completed"])
    expect(journal.filter((record) => record.name === toolResultEvent.name)).toEqual([])
    // The next prompt holds the first turn's message and its text, not the call no result answered.
    const prompts = heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace] : []))
    const last = prompts.at(-1)!
    expect(last.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"])
    expect(last.messages[2]?.callIds).toEqual([])
    // The Context tab still finds the record each sent message came from, the stripped call's answer included.
    const board = heard.reduce((all, trace) => record(all, trace, 0), emptyBoard(runtime.conversation))
    const rows = Option.getOrThrow(viewOf(board, 2).calls[0]!.memory)
    expect(rows.map((row) => Option.isSome(row.seq))).toEqual([true, true, true])
  }, 20_000)

  test("at the last step the messages waiting are left for turns of their own", async () => {
    const { runtime, heard } = await start({ ...SOURCES, agent: apply("one-step", DEFAULT_AGENT) })
    const done = replies(runtime, 3)
    tools.three.forEach((text) => runtime.send(text))
    await done
    expect(await named(runtime, turnEndedEvent.name)).toHaveLength(3)
    expect(replyTexts(heard)).toEqual(["I stopped after 1 steps.", "I stopped after 1 steps.", "I stopped after 1 steps."])
  })

  test("a tool that throws is a failed result, and the program goes on", async () => {
    const throwing = DEFAULT_TOOLS.replace("notes.push(note)", "notes.push(note.missing.field)")
    expect(throwing).not.toBe(DEFAULT_TOOLS)
    const { runtime, heard } = await start({ ...SOURCES, tools: throwing })
    const done = replies(runtime)
    runtime.send("Remember to buy milk.")
    await done
    expect(replyTexts(heard)[0]).toContain("remember failed:")
    expect(heard.some((trace) => trace._tag === "Ended")).toBe(false)
  })

  test("every experiment and control finds its line in the starter code", () => {
    for (const [id, experiment] of Object.entries(tools.experiments)) {
      const source = experiment.file === "tools" ? DEFAULT_TOOLS : DEFAULT_AGENT
      const next = experiment.apply(source)
      expect([id, Option.isSome(next) && next.value !== source]).toEqual([id, true])
    }
    expect(tools.controls.maxSteps!.read(DEFAULT_AGENT)).toEqual(Option.some(5))
    expect(Option.map(tools.controls.maxSteps!.write(DEFAULT_AGENT, 2), (agent) => agent.includes("const MAX_STEPS = 2"))).toEqual(Option.some(true))
    expect(tools.controls.system!.read(DEFAULT_AGENT)).toEqual(Option.some("You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."))
  })
})
