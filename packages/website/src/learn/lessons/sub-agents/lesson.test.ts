// Lesson 4 on the page's runtime, with Echo: the chat's agent hands a task to
// a helper, which works in a session of its own; the chat's journal holds the
// call and the helper's answer; each experiment does what the page says.
import { afterEach, describe, expect, test } from "bun:test"
import { Option } from "effect"
import { toolResultEvent } from "@xandreed/core/kernel"
import { loadEcho } from "../../models/mock.ts"
import { LessonRuntime } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { DEFAULT_MEMORY } from "../tools/memory.source.ts"
import { DEFAULT_AGENT } from "./agent.source.ts"
import { subAgents } from "./lesson.ts"
import { DEFAULT_LOOP } from "./loop.source.ts"
import { DEFAULT_TOOLS } from "./tools.source.ts"

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES = { agent: DEFAULT_AGENT, tools: DEFAULT_TOOLS, loop: DEFAULT_LOOP, memory: DEFAULT_MEMORY }

const start = async (sources: Record<string, string> = SOURCES) => {
  const runtime = await LessonRuntime.create(subAgents)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<Trace> = []
  runtime.onTrace((trace) => heard.push(trace))
  expect(await runtime.start(sources)).toEqual({ _tag: "Built" })
  return { runtime, heard }
}
const replies = (runtime: LessonRuntime, count = 1) => new Promise<void>((resolve) => {
  let seen = 0
  const stop = runtime.onTrace((trace) => { if ((trace._tag === "Reply" || trace._tag === "Failed") && ++seen >= count) { stop(); resolve() } })
})
const replyTexts = (heard: ReadonlyArray<Trace>) => heard.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))
const apply = (id: string, source: string) => Option.getOrThrow(subAgents.experiments[id]!.apply(source))

describe("lesson 4 on the page (the kernel, Echo)", () => {
  test("the chat hands a task to a helper, which works in a session of its own, and the chat answers from its answer", async () => {
    const { runtime, heard } = await start()
    const busyAtHelperEnd: Array<boolean> = []
    runtime.onTrace((trace) => { if (trace._tag === "Event" && trace.event.name === "core.session.turn.ended" && trace.event.session !== runtime.conversation) busyAtHelperEnd.push(runtime.busy) })
    const done = replies(runtime)
    runtime.send("Ask a helper: what is 6 * 7?")
    await done
    expect(replyTexts(heard)).toEqual(["The helper answered: The tool answered: calculator says 42."])
    // The chat's journal: the delegate call's result names the helper's session; the helper's work is not in it.
    const results = (await runtime.journal()).filter((record) => record.name === toolResultEvent.name).map((record) => record.message)
    expect(results).toEqual([{ _tag: "ToolResult", id: expect.stringMatching(/^echo-call-/), name: "delegate", result: { answer: "The tool answered: calculator says 42.", session: expect.stringMatching(/^[0-9a-f-]{36}$/) }, isFailure: false }])
    // Four model calls: the chat's, the helper's two, the chat's again; each prompt stamped with its own session.
    const sessions = heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace.session === runtime.conversation ? "chat" : "helper"] : []))
    expect(sessions).toEqual(["chat", "helper", "helper", "chat"])
    expect(busyAtHelperEnd).toEqual([true])
  })

  test("in the chat's own session, the helper is refused as busy, and the chat's model reads the failure", async () => {
    const { runtime, heard } = await start({ ...SOURCES, agent: apply("same-session", DEFAULT_AGENT) })
    const done = replies(runtime)
    runtime.send("Ask a helper: what is 6 * 7?")
    await done
    expect(replyTexts(heard)[0]).toMatch(/^The tool answered: delegate failed: ".*busy.*"\.$/)
  })

  test("without delegate, the chat's agent works it out in its own session", async () => {
    const { runtime, heard } = await start({ ...SOURCES, agent: apply("no-delegate", DEFAULT_AGENT) })
    const done = replies(runtime)
    runtime.send("Ask a helper: what is 6 * 7?")
    await done
    expect(replyTexts(heard)).toEqual(["The tool answered: calculator says 42."])
    expect(heard.filter((trace) => trace._tag === "Prompt" && trace.session !== runtime.conversation)).toEqual([])
  })

  test("every experiment finds its line in the default code", () => {
    for (const [id, experiment] of Object.entries(subAgents.experiments)) {
      const source = { agent: DEFAULT_AGENT, tools: DEFAULT_TOOLS }[experiment.file] ?? ""
      expect([id, Option.isSome(experiment.apply(source))]).toEqual([id, true])
    }
  })
})
