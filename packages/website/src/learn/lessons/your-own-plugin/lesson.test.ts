// Lesson 3 on the page's runtime, with Echo: the meter counts each turn on the
// status line, from what the provider reported for each answer, the clock's
// note reaches the model and never the journal, and every experiment finds
// its line and does what the page says it does.
import { afterEach, describe, expect, test } from "bun:test"
import { Option } from "effect"
import { assistantMessageEvent, userMessageEvent } from "@xandreed/core/kernel"
import { loadEcho } from "../../models/mock.ts"
import { LessonRuntime } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { DEFAULT_MEMORY } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS } from "../tools/tools.source.ts"
import { DEFAULT_AGENT } from "./agent.source.ts"
import { DEFAULT_PLUGIN } from "./plugin.source.ts"
import { yourOwnPlugin } from "./lesson.ts"

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES = { plugin: DEFAULT_PLUGIN, agent: DEFAULT_AGENT, tools: DEFAULT_TOOLS, memory: DEFAULT_MEMORY }
const NOTE = /^\[Host note: it is .+\.\]$/

const start = async (sources: Record<string, string> = SOURCES) => {
  const runtime = await LessonRuntime.create(yourOwnPlugin)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<Trace> = []
  runtime.onTrace((trace) => heard.push(trace))
  expect(await runtime.start(sources)).toEqual({ _tag: "Built" })
  return { runtime, heard }
}

const until = (runtime: LessonRuntime, match: (trace: Trace) => boolean) => new Promise<void>((resolve) => {
  const stop = runtime.onTrace((trace) => { if (match(trace)) { stop(); resolve() } })
})
/** Send one message and wait for its turn's end on the status line, which the meter writes last. */
const say = async (runtime: LessonRuntime, text: string, ended: (status: string) => boolean = (status) => /^turn \d+: ~/.test(status)) => {
  const done = until(runtime, (trace) => trace._tag === "Status" && ended(trace.text))
  runtime.send(text)
  await done
}
const replyTexts = (heard: ReadonlyArray<Trace>) => heard.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))
const statuses = (heard: ReadonlyArray<Trace>) => heard.flatMap((trace) => (trace._tag === "Status" ? [trace.text] : []))
const prompts = (heard: ReadonlyArray<Trace>) => heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace.messages.map((said) => `${said.role}: ${said.text}`)] : []))
const contexts = (heard: ReadonlyArray<Trace>) => heard.flatMap((trace) => (trace._tag === "Context" ? [trace.messages.map((said) => `${said.role}: ${said.text}`)] : []))
const apply = (id: string, source: string) => Option.getOrThrow(yourOwnPlugin.experiments[id]!.apply(source))

describe("lesson 3 on the page (the kernel, Echo)", () => {
  test("the clock's note reaches the model after the context, and is never stored", async () => {
    const { runtime, heard } = await start()
    await say(runtime, "What time is it?")
    expect(replyTexts(heard)[0]).toMatch(/^A note your code added to this request says it is .+\. It was not stored: the next request gets its own\.$/)
    const sent = prompts(heard)[0] ?? []
    expect(sent.at(-1)).toMatch(/^user: \[Host note: it is .+\.\]$/)
    expect(sent.slice(0, -1).at(-1)).toBe("user: What time is it?")
    // The page watches the memory below the wrapper: what memory returned has no note.
    expect(contexts(heard)[0]).toEqual(["user: What time is it?"])
    expect((await runtime.journal()).filter((record) => record.message !== undefined && "text" in record.message && NOTE.test(record.message.text))).toEqual([])
  })

  test("the meter shows each turn's count and the total when the turn ends", async () => {
    const { runtime, heard } = await start()
    await say(runtime, "Hi, I'm Ana.")
    await say(runtime, "What did I say earlier?")
    const counts = statuses(heard).filter((status) => /^turn \d+: ~\d+ tok, ~\d+ in all$/.test(status))
    expect(counts.length).toBe(2)
    const [first, second] = counts.map((status) => status.match(/~(\d+) tok, ~(\d+) in all/)!.slice(1).map(Number))
    expect(first![0]).toBe(first![1])
    expect(second![1]).toBe(first![1]! + second![0]!)
  })

  test("the meter counts what the provider reported for each answer, which modelAnswer stored with it", async () => {
    const { runtime, heard } = await start()
    await say(runtime, "Hi, I'm Ana.")
    await say(runtime, "What is 12 * 3?")
    // Echo reports a quarter of each answer's characters: 30 for its greeting; 6 for its words before the call and 10 for its answer after it.
    expect(statuses(heard).filter((status) => status.includes(" tok, "))).toEqual(["turn 1: ~30 tok, ~30 in all", "turn 2: ~16 tok, ~46 in all"])
    const reported = heard.flatMap((trace) => (trace._tag === "Usage" ? [[trace.turn, trace.usage.outputTokens]] : []))
    expect(reported).toEqual([[1, 30], [2, 6], [2, 10]])
    // Each answer's record holds the report, so the meter's listener reads it there and estimates nothing.
    // (What it read is left out here: the clock's note is in it, and its length changes with the time.)
    const stored = (await runtime.journal()).filter((record) => record.name === assistantMessageEvent.name)
      .map((record) => (record.data as { readonly usage?: { readonly outputTokens?: number } }).usage?.outputTokens)
    expect(stored).toEqual([30, 6, 10])
  })

  test("a sum still goes to the calculator with the note after it, and the note is not a sum", async () => {
    const { runtime, heard } = await start()
    await say(runtime, "What is 12 * 3?")
    expect(replyTexts(heard)).toEqual(["The tool answered: calculator says 36."])
  })

  test("stored as a message, the clock piles up: every request carries every earlier note", async () => {
    const { runtime, heard } = await start({ ...SOURCES, plugin: apply("store-clock", DEFAULT_PLUGIN) })
    await say(runtime, "Hi, I'm Ana.")
    await say(runtime, "What did I say earlier?")
    expect((prompts(heard).at(-1) ?? []).filter((line) => /^user: \[Host note: it is /.test(line)).length).toBe(2)
    expect((await runtime.journal()).filter((record) => record.name === userMessageEvent.name).length).toBe(4)
  })

  test("a wrapper that drops the first message hides how the conversation began", async () => {
    const { runtime, heard } = await start({ ...SOURCES, plugin: apply("drop-first", DEFAULT_PLUGIN) })
    await say(runtime, "Hi, I'm Ana.")
    await say(runtime, "What did I say earlier?")
    expect(prompts(heard).at(-1)).not.toContain("user: Hi, I'm Ana.")
  })

  test("unplugged, the meter counts nothing, and the agent answers as before", async () => {
    const { runtime, heard } = await start({ ...SOURCES, agent: apply("unplug-meter", DEFAULT_AGENT) })
    const done = until(runtime, (trace) => trace._tag === "Reply")
    runtime.send("Hi, I'm Ana.")
    await done
    expect(statuses(heard).some((status) => status.includes(" tok, "))).toBe(false)
  })

  test("Rebuild closes the meter's scope: a program built without it counts nothing", async () => {
    const { runtime, heard } = await start()
    await say(runtime, "Hi, I'm Ana.")
    expect(await runtime.start({ ...SOURCES, agent: apply("unplug-meter", DEFAULT_AGENT) })).toEqual({ _tag: "Built" })
    const before = statuses(heard).length
    const done = until(runtime, (trace) => trace._tag === "Reply")
    runtime.send("Hi again.")
    await done
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(statuses(heard).slice(before).filter((status) => status.includes(" tok, "))).toEqual([])
  })

  test("every experiment finds its line in the default code", () => {
    for (const [id, experiment] of Object.entries(yourOwnPlugin.experiments)) {
      const source = { plugin: DEFAULT_PLUGIN, agent: DEFAULT_AGENT }[experiment.file] ?? ""
      expect([id, Option.isSome(experiment.apply(source))]).toEqual([id, true])
    }
  })
})
