// The page's runtime over lesson 1: the learner's program runs as one fiber
// over a base built once, with the Echo model, and the page hears what it
// does. These pin what the workbench shows: the order of a turn, the queue,
// rebuild, stop, clear, and the defect of a removed module.
import { afterEach, describe, expect, test } from "bun:test"
import { Option } from "effect"
import { turnEndedEvent } from "@xandreed/core/kernel"
import { loadEcho } from "./models/mock.ts"
import { DEFAULT_AGENT } from "./lessons/your-first-agent/agent.source.ts"
import { DEFAULT_MEMORY } from "./lessons/your-first-agent/memory.source.ts"
import { withoutMemory, writeLastN, writeSystem } from "./lessons/your-first-agent/config-edit.ts"
import { yourFirstAgent } from "./lessons/your-first-agent/lesson.ts"
import { LessonRuntime } from "./runtime.ts"
import type { Trace } from "./runtime.ts"

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES = { agent: DEFAULT_AGENT, memory: DEFAULT_MEMORY }

const start = async (sources: Record<string, string> = SOURCES) => {
  const runtime = await LessonRuntime.create(yourFirstAgent)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<Trace> = []
  runtime.onTrace((trace) => heard.push(trace))
  const built = await runtime.start(sources)
  return { runtime, heard, built }
}

/** Resolves with the traces heard once `count` traces match. */
const until = (runtime: LessonRuntime, match: (trace: Trace) => boolean, count = 1) => new Promise<void>((resolve) => {
  let seen = 0
  const stop = runtime.onTrace((trace) => { if (match(trace) && ++seen >= count) { stop(); resolve() } })
})
const replies = (runtime: LessonRuntime, count = 1) => until(runtime, (trace) => trace._tag === "Reply" || trace._tag === "Failed", count)
const replyTexts = (heard: ReadonlyArray<Trace>) => heard.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))
const prompts = (heard: ReadonlyArray<Trace>) => heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace] : []))
const endings = async (runtime: LessonRuntime) => (await runtime.journal()).flatMap((record) =>
  record.name === turnEndedEvent.name ? [(record.data as { readonly outcome: { readonly _tag: string } }).outcome._tag] : [])
const step = (trace: Trace): string => trace._tag === "Event" ? `${trace.event._tag === "Stored" ? "stored" : "live"} ${trace.event.name}` : trace._tag

describe("lesson 1 on the page (the kernel, Echo)", () => {
  test("the program runs and answers, and the page hears the turn in its order", async () => {
    const { runtime, heard, built } = await start()
    expect(built).toEqual({ _tag: "Built" })
    const done = replies(runtime)
    runtime.send("tell me about loops")
    await done
    expect(replyTexts(heard)).toEqual(["You said: \"tell me about loops\". This is the start of the conversation."])
    const order = [...new Set(heard.map(step))]
    expect(order).toEqual([
      // The boot hook waits on the turn's start: it has run before the page's own log hears the record.
      "Status",
      "stored core.session.turn.started",
      "stored conversation.user.message",
      "Context",
      "Prompt",
      "Piece",
      "Usage",
      "stored conversation.assistant.message",
      "stored core.session.turn.ended",
      "Reply",
    ])
    // The boot hook named the turn; memory built the context from the journal up to the user's message.
    expect(heard.find((trace) => trace._tag === "Status")).toMatchObject({ text: "turn 1", turn: 1 })
    expect(heard.find((trace) => trace._tag === "Context")).toMatchObject({ turn: 1, upTo: 2, messages: [{ role: "user", text: "tell me about loops" }] })
    expect(prompts(heard)[0]).toMatchObject({ turn: 1, messages: [{ role: "system", text: "You are a friendly tutor. Keep answers short." }, { role: "user", text: "tell me about loops" }] })
  })

  test("three sent at once: the first turn takes the two waiting behind it, stores all three, and answers them together", async () => {
    const { runtime, heard } = await start()
    const done = replies(runtime)
    yourFirstAgent.three.forEach((text) => runtime.send(text))
    await done
    expect(replyTexts(heard)).toEqual(["You sent 3 messages: \"My name is Ana.\", \"What did I just say?\", \"What is in your context?\". They start the conversation."])
    expect(prompts(heard).map((prompt) => [prompt.turn, prompt.messages.length])).toEqual([[1, 4]])
  })

  test("messages sent while a turn runs wait, and the next turn takes them all", async () => {
    const { runtime, heard } = await start()
    const streaming = until(runtime, (trace) => trace._tag === "Piece")
    const done = replies(runtime, 2)
    runtime.send("My name is Ana.")
    await streaming
    runtime.send("What did I just say?")
    runtime.send("And now?")
    await done
    expect(prompts(heard).map((prompt) => [prompt.turn, prompt.messages.map((message) => message.role).join(",")])).toEqual([
      [1, "system,user"],
      [2, "system,user,assistant,user,user"],
    ])
    expect(replyTexts(heard)[1]).toStartWith("You sent 2 messages:")
  })

  test("a rebuild keeps the conversation, and the changed system text is in the next prompt only", async () => {
    const { runtime, heard } = await start()
    const first = replies(runtime)
    runtime.send("first")
    await first
    expect(await runtime.start({ ...SOURCES, agent: Option.getOrThrow(writeSystem(DEFAULT_AGENT, "You are a pirate.")) })).toEqual({ _tag: "Built" })
    const second = replies(runtime)
    runtime.send("second")
    await second
    expect(prompts(heard).map((prompt) => prompt.messages[0]?.text)).toEqual(["You are a friendly tutor. Keep answers short.", "You are a pirate."])
    expect(prompts(heard)[1]?.messages.length).toBe(4)
    // The journal never holds the system text.
    expect(JSON.stringify(await runtime.journal())).not.toContain("pirate")
  })

  test("a rebuild mid-turn stops that turn, which closes Interrupted, and keeps the messages still waiting", async () => {
    const { runtime, heard } = await start()
    const streaming = until(runtime, (trace) => trace._tag === "Piece")
    runtime.send("a message that takes a little while to answer")
    await streaming
    runtime.send("and one that waits")
    const answered = replies(runtime)
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    await answered
    expect(await endings(runtime)).toEqual(["Interrupted", "Completed"])
    // The stopped turn stored its message and no answer: the next turn's context holds both, and Echo answers both.
    expect(replyTexts(heard)).toEqual(["You sent 2 messages: \"a message that takes a little while to …\", \"and one that waits\". They start the conversation."])
    expect(heard.some((trace) => trace._tag === "Ended")).toBe(false)
  })

  test("stop drops the messages still waiting, stops the turn, and the program takes the next message", async () => {
    const { runtime, heard } = await start()
    const streaming = until(runtime, (trace) => trace._tag === "Piece")
    runtime.send("one")
    await streaming
    runtime.send("two")
    runtime.send("three")
    const stopped = await runtime.stop()
    expect(stopped).toEqual({ dropped: ["two", "three"], result: { _tag: "Built" } })
    const next = replies(runtime)
    runtime.send("four")
    await next
    expect(await endings(runtime)).toEqual(["Interrupted", "Completed"])
    expect(replyTexts(heard)).toHaveLength(1)
  })

  test("clear starts a new, empty conversation, and the old one stays in the store", async () => {
    const { runtime } = await start()
    const first = replies(runtime)
    runtime.send("remember me")
    await first
    const old = runtime.conversation
    expect(await runtime.clear()).toEqual({ _tag: "Built" })
    expect(runtime.conversation).not.toBe(old)
    expect(await runtime.journal()).toEqual([])
  })

  test("clear mid-answer: once it returns, the old program says nothing more, and the new conversation answers from scratch", async () => {
    const { runtime } = await start()
    const streaming = until(runtime, (trace) => trace._tag === "Piece")
    runtime.send("a long answer, please")
    await streaming
    expect(await runtime.clear()).toEqual({ _tag: "Built" })
    const after: Array<Trace> = []
    runtime.onTrace((trace) => after.push(trace))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(after).toEqual([])
    const next = replies(runtime)
    runtime.send("fresh")
    await next
    expect(after.flatMap((trace) => (trace._tag === "Reply" ? [trace] : []))).toEqual([{ _tag: "Reply", turn: 1, text: "You said: \"fresh\". This is the start of the conversation." }])
  })

  test("with memory.ts keeping the last two messages, the third prompt sends two after the system text", async () => {
    const { runtime, heard } = await start({ ...SOURCES, memory: Option.getOrThrow(writeLastN(DEFAULT_MEMORY, 2)) })
    // One by one: each sent once the one before has its answer.
    for (const text of ["a", "b", "c"]) {
      const done = replies(runtime)
      runtime.send(text)
      await done
    }
    expect(prompts(heard).map((prompt) => prompt.messages.length)).toEqual([2, 3, 3])
  })

  test("main without its memory runs, and stops at the first message with the missing service, in words", async () => {
    const { runtime, heard, built } = await start({ ...SOURCES, agent: Option.getOrThrow(withoutMemory(DEFAULT_AGENT)) })
    expect(built).toEqual({ _tag: "Built" })
    const ended = until(runtime, (trace) => trace._tag === "Ended")
    runtime.send("hello")
    await ended
    expect(heard.find((trace) => trace._tag === "Ended")).toMatchObject({ reason: expect.stringContaining("Memory") })
    expect(replyTexts(heard)).toEqual([])
  })

  test("code that does not run is refused before anything starts, by file and in words", async () => {
    const { runtime } = await start()
    expect(await runtime.start({ ...SOURCES, agent: "const main = (" })).toMatchObject({ _tag: "Refused", message: expect.stringContaining("agent.ts did not run: ") })
    expect(await runtime.start({ ...SOURCES, memory: "Layer.succeed(Memry, {})" })).toMatchObject({ _tag: "Refused", message: expect.stringContaining("memory.ts did not run: ") })
    expect(await runtime.start({ ...SOURCES, agent: "const main = 42" })).toMatchObject({ _tag: "Refused", message: expect.stringContaining("main is not an Effect") })
    expect(runtime.running).toBe(false)
  })
})
