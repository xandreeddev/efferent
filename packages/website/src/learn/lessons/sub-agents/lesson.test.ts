// Lesson 4 on the page's runtime, with Echo: the chat's agent hands a task to
// a helper, which works in a session of its own, created under the session
// whose turn called it; the chat's journal holds the call and the helper's
// answer; each experiment does what the page says.
import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { Sessions, toolResultEvent, turnStartedEvent } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"
import type { Lesson, PageParts } from "../../lesson.ts"
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

const start = async (sources: Record<string, string> = SOURCES, lesson: Lesson = subAgents) => {
  const runtime = await LessonRuntime.create(lesson)
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

/**
 * The lesson, and the page's parts as its program was given them: through them a test reads the header of any
 * session in the page's store, a helper's included, which the chat's journal only names.
 */
const withParts = () => {
  let given: Option.Option<PageParts> = Option.none()
  const lesson: Lesson = { ...subAgents, evaluate: (sources, parts) => { given = Option.some(parts); return subAgents.evaluate(sources, parts) } }
  const headerOf = (session: SessionId) => {
    const parts = Option.getOrThrow(given)
    const stack = parts.sessions().pipe(Layer.provide(parts.inProcessJournal()), Layer.provide(parts.kernel()))
    return Effect.runPromise(Effect.scoped(Effect.flatMap(Layer.build(stack), (built) => Effect.map(Context.get(built, Sessions).read(session), (journal) => journal.header))))
  }
  return { lesson, headerOf }
}
/** The sessions a turn was opened in, in order. */
const turnsOpenedIn = (heard: ReadonlyArray<Trace>): ReadonlyArray<SessionId> =>
  heard.flatMap((trace) => (trace._tag === "Event" && trace.event._tag === "Stored" && trace.event.name === turnStartedEvent.name ? [trace.event.session] : []))

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

  test("the helper's session is created under the turn that called it: its header names the chat's session as its parent", async () => {
    const { lesson, headerOf } = withParts()
    const { runtime, heard } = await start(SOURCES, lesson)
    const done = replies(runtime)
    runtime.send("Ask a helper: what is 6 * 7?")
    await done
    const [chat, helper] = turnsOpenedIn(heard)
    expect(chat).toBe(runtime.conversation)
    expect(await headerOf(helper!)).toMatchObject({ id: helper, owner: "helper", parent: runtime.conversation })
    // The link the other way: the delegate result the chat stored names that session.
    const result = (await runtime.journal()).find((record) => record.name === toolResultEvent.name)?.message
    expect(result).toMatchObject({ name: "delegate", result: { session: helper } })
  })

  test("the parent is the session of the turn delegate ran in, not the chat's: a turn in another session is the helper's parent", async () => {
    // The same program, but its turn runs in a session of its own making, not the one the chat shows.
    const elsewhere = DEFAULT_AGENT.replace(
      "        const session = yield* sessions.open(chat.session)\n",
      "        const session = yield* sessions.open(yield* sessions.create({ owner: \"another\" }))\n",
    )
    expect(elsewhere).not.toBe(DEFAULT_AGENT)
    const { lesson, headerOf } = withParts()
    const { runtime, heard } = await start({ ...SOURCES, agent: elsewhere }, lesson)
    const done = replies(runtime)
    runtime.send("Ask a helper: what is 6 * 7?")
    await done
    expect(replyTexts(heard)).toEqual(["The helper answered: The tool answered: calculator says 42."])
    const [caller, helper] = turnsOpenedIn(heard)
    expect(caller).not.toBe(runtime.conversation)
    expect(await headerOf(caller!)).toMatchObject({ owner: "another" })
    expect(await headerOf(helper!)).toMatchObject({ owner: "helper", parent: caller })
    // delegate takes the session from the turn its call runs in, and the helper is created under what it is given.
    expect(DEFAULT_TOOLS).toContain("dependencies: [CurrentTurn]")
    expect(DEFAULT_TOOLS).toContain("return yield* helper.ask(task, turn.id)")
    expect(DEFAULT_AGENT).toContain("const session = yield* sessions.create({ owner: \"helper\", parent })")
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

  test("a message sent while the helper works steers the chat, not the helper: one chat turn, and the helper never sees it", async () => {
    const { runtime, heard } = await start({ ...SOURCES, tools: apply("slow-helper", DEFAULT_TOOLS) })
    const helperAtWork = new Promise<void>((resolve) => { const stop = runtime.onTrace((trace) => { if (trace._tag === "Status" && trace.text.startsWith("helper:")) { stop(); resolve() } }) })
    const done = replies(runtime)
    runtime.send("Ask a helper: what is 6 * 7?")
    await helperAtWork
    runtime.send("Thanks!")
    await done
    expect(replyTexts(heard)).toEqual(["The helper answered: The tool answered: calculator says 42. You also said: \"Thanks!\"."])
    expect((await runtime.journal()).filter((record) => record.name === "core.session.turn.started").length).toBe(1)
    const helperPrompts = heard.flatMap((trace) => (trace._tag === "Prompt" && trace.session !== runtime.conversation ? [JSON.stringify(trace.messages)] : []))
    expect(helperPrompts.length).toBe(2)
    expect(helperPrompts.some((prompt) => prompt.includes("Thanks!"))).toBe(false)
  }, 20_000)

  test("the system-text control reads and writes the chat's line, never the helper's", () => {
    const control = subAgents.controls.system!
    expect(control.read(DEFAULT_AGENT)).toEqual(Option.some("You are a helpful assistant. Hand a task to a helper with delegate, then answer in one short sentence."))
    const written = Option.getOrThrow(control.write(DEFAULT_AGENT, "You are a pirate."))
    // The string is written where it stood, on the line after `const system =`, and the helper's is untouched.
    expect(written).toContain('const system =\n  "You are a pirate."\nconst helperSystem =\n  "You are a helper. Do the task you are given, then answer in one short sentence."')
  })

  test("every experiment finds its line in the default code", () => {
    for (const [id, experiment] of Object.entries(subAgents.experiments)) {
      const source = { agent: DEFAULT_AGENT, tools: DEFAULT_TOOLS }[experiment.file] ?? ""
      expect([id, Option.isSome(experiment.apply(source))]).toEqual([id, true])
    }
  })
})
