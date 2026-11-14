// Lesson 6 on the page's runtime, with Echo: "show a table of …" goes to
// show, whose view is stored in the chat's journal and folded by viewsOf;
// its progress is heard live; the model's prompts hold none of the cells;
// each experiment does what the page says, and the system-text control finds
// its line.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Option } from "effect"
import { viewsOf } from "@xandreed/sdk/kernel"
import { loadEcho } from "../../models/mock.ts"
import { LessonRuntime } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { DEFAULT_MEMORY } from "../tools/memory.source.ts"
import { BASE_AGENT, IMPORTS as BASE_IMPORTS } from "../base/agent.source.ts"
import { DEFAULT_AGENT, IMPORTS, REPLACED } from "./agent.source.ts"
import { render } from "./lesson.ts"
import { DEFAULT_TOOLS } from "./tools.source.ts"

setDefaultTimeout(60_000)
const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES = { tools: DEFAULT_TOOLS, agent: DEFAULT_AGENT, memory: DEFAULT_MEMORY }
const start = async (sources: Record<string, string> = SOURCES) => {
  const runtime = await LessonRuntime.create(render)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<Trace> = []
  runtime.onTrace((trace) => heard.push(trace))
  expect(await runtime.start(sources)).toEqual({ _tag: "Built" })
  return { runtime, heard }
}
const oneByOne = (runtime: LessonRuntime, messages: ReadonlyArray<string>) => new Promise<void>((resolve) => {
  let next = 0
  const stop = runtime.onTrace((trace) => {
    if (trace._tag !== "Reply" && trace._tag !== "Failed") return
    if (next >= messages.length) { stop(); resolve(); return }
    runtime.send(messages[next++]!)
  })
  runtime.send(messages[next++]!)
})
const apply = (id: string, source: string) => Option.getOrThrow(render.experiments[id]!.apply(source))
const replies = (heard: ReadonlyArray<Trace>) => heard.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))
const prompts = (heard: ReadonlyArray<Trace>) => heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace.messages] : []))

describe("lesson 6 on the page (the kernel, Echo)", () => {
  test("show stores a view the chat folds, its progress is heard live, and the model reads a few words", async () => {
    const { runtime, heard } = await start()
    await oneByOne(runtime, ["Show a table of squares to 3."])
    expect(replies(heard)).toEqual(["The tool answered: show says \"shown as squares\"."])
    const shown = viewsOf(await runtime.journal())
    expect(shown.map(({ id, view }) => ({ id: String(id), view }))).toEqual([{ id: "squares", view: { _tag: "Table", title: "Squares to 3", columns: ["n", "n²"], rows: [["1", "1"], ["2", "4"], ["3", "9"]] } }])
    const progress = heard.flatMap((trace) => (trace._tag === "Event" && trace.event._tag === "Live" && trace.event.name === "plugin.render.progress" ? [trace.event.data] : []))
    expect(progress).toEqual([{ id: "squares", done: 1, total: 3 }, { id: "squares", done: 2, total: 3 }, { id: "squares", done: 3, total: 3 }])
    // No message the model was sent, whoever's, holds the table: Echo asked in a few words, and the tool made the rows.
    expect(prompts(heard).flat().some((message) => message.text.includes("n²"))).toBe(false)
  })

  test("showing again under the same id replaces the view, which keeps its first place", async () => {
    const { runtime } = await start()
    await oneByOne(runtime, ["Show a table of squares to 3.", "Show the times table of 7.", "Show a table of squares to 8."])
    const shown = viewsOf(await runtime.journal())
    expect(shown.map((one) => String(one.id))).toEqual(["squares", "times-7"])
    expect(shown[0]?.view._tag === "Table" && shown[0].view.rows.length).toBe(8)
  })

  test("the wrong way, the table as the tool's result, sends the cells to the model in every later request", async () => {
    const { runtime, heard } = await start({ ...SOURCES, tools: apply("table-as-result", DEFAULT_TOOLS) })
    await oneByOne(runtime, ["Show a table of squares to 3.", "Hello."])
    const last = prompts(heard).at(-1) ?? []
    expect(last.some((message) => message.role === "tool" && message.text.includes("n | n²"))).toBe(true)
  })

  test("the base program still holds what this lesson replaces in it, and callTool is what gives each call its turn", () => {
    for (const [from] of REPLACED) expect({ from, held: BASE_AGENT.split(from).length - 1 }).toEqual({ from, held: 1 })
    expect(IMPORTS).toBe(BASE_IMPORTS)
    expect(DEFAULT_AGENT).toContain('const system =\n  "You are a helpful assistant. To show the user a table, use show. Answer in one short sentence."')
    // The loop names no turn itself: callTool provides it, and show, which declares CurrentTurn, takes it from there.
    expect(DEFAULT_AGENT).toContain("yield* callTool(toolkit, call, session)")
    expect(`${IMPORTS}\n${DEFAULT_AGENT}`).not.toContain("CurrentTurn")
    expect(DEFAULT_TOOLS).toContain("dependencies: [CurrentTurn]")
    expect(DEFAULT_TOOLS).toContain("const session = yield* CurrentTurn")
    // A write through the turn cannot fail in its type, so the handler wraps none of them.
    expect(DEFAULT_TOOLS).not.toContain("Effect.orDie")
  })

  test("every experiment finds its line in the starter code, and the system-text control reads and writes its line", () => {
    expect(Object.keys(render.experiments)).toEqual(["slow-show", "table-as-result"])
    for (const [id, experiment] of Object.entries(render.experiments)) {
      const source = { tools: DEFAULT_TOOLS, agent: DEFAULT_AGENT }[experiment.file] ?? ""
      const next = experiment.apply(source)
      expect([id, Option.isSome(next) && next.value !== source]).toEqual([id, true])
    }
    const control = render.controls.system!
    expect(control.read(DEFAULT_AGENT)).toEqual(Option.some("You are a helpful assistant. To show the user a table, use show. Answer in one short sentence."))
    expect(Option.flatMap(control.write(DEFAULT_AGENT, "You are a pirate."), control.read)).toEqual(Option.some("You are a pirate."))
  })
})
