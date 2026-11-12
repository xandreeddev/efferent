import { afterEach, describe, expect, test } from "bun:test"
import { Option } from "effect"
import { dataOf, turnEndedEvent } from "@xandreed/core/kernel"
import { requestSentEvent } from "@xandreed/sdk/kernel"
import type { StoredEvent } from "@xandreed/core/kernel"
import { loadEcho } from "./models/mock.ts"
import { DEFAULT_AGENT } from "./lesson1.source.ts"
import { DEFAULT_TINY } from "./tiny-memory.source.ts"
import { setField, withoutMemory } from "./config-edit.ts"
import { LessonRuntime } from "./runtime.ts"
import type { LessonEvent } from "./runtime.ts"

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const start = async (agent = DEFAULT_AGENT) => {
  const runtime = await LessonRuntime.create()
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<LessonEvent> = []
  runtime.onEvent((event) => heard.push(event))
  const built = await runtime.rebuild(agent, DEFAULT_TINY)
  return { runtime, heard, built }
}

const set = (source: string, key: Parameters<typeof setField>[1], value: string | number) => Option.getOrThrow(setField(source, key, value))
const sentOf = (journal: ReadonlyArray<StoredEvent>) => journal.flatMap((event) => Option.toArray(dataOf(requestSentEvent, event)))
const endsOf = (journal: ReadonlyArray<StoredEvent>) => journal.flatMap((event) => Option.toArray(dataOf(turnEndedEvent, event))).map((end) => ({ turn: Number(end.turn), outcome: end.outcome }))
/** Resolves once the page has heard an event of this tag. */
const heardOnce = (runtime: LessonRuntime, tag: LessonEvent["_tag"]) => new Promise<void>((resolve) => {
  const stop = runtime.onEvent((event) => { if (event._tag === tag) { stop(); resolve() } })
})

describe("lesson 1 runtime (the kernel, Echo model)", () => {
  test("the default agent builds and answers, and the page hears the turn's events in order", async () => {
    const { runtime, heard, built } = await start()
    expect(built).toEqual({ _tag: "Built" })
    const [sent] = await runtime.send(["tell me about loops"])
    expect(await sent?.outcome).toEqual({ _tag: "Replied", text: "You said: \"tell me about loops\". This is the start of the conversation." })
    expect([...new Set(heard.map((event) => event._tag))]).toEqual(["Queued", "TurnStarted", "UserMessage", "RequestSent", "Delta", "AssistantMessage", "TurnEnded"])
    expect(heard.find((event) => event._tag === "RequestSent")).toMatchObject({ name: "plugin.loop.request.sent", turn: 1, step: 1, messages: 1, budgetTokens: 3000 })
  })

  test("three messages queued at once: each gets a ticket, then a turn of its own, in order", async () => {
    const { runtime, heard } = await start()
    const sent = await runtime.send(["My name is Ana.", "What did I just say?", "What is in your context?"])
    const outcomes = await Promise.all(sent.map((entry) => entry.outcome))
    expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Replied", "Replied", "Replied"])
    // The second turn saw the first, though both were queued before either ran.
    expect(outcomes[1]).toEqual({ _tag: "Replied", text: "Earlier you said: \"My name is Ana.\"." })
    expect(heard.flatMap((event) => event._tag === "Queued" ? [[event.id, event.ticket, event.text]] : []))
      .toEqual(sent.map((entry, index) => [entry.id, index + 1, entry.text]))
    // All three were queued before the first turn started, and each turn's user message is paired with its own.
    expect(heard.slice(0, 4).map((event) => event._tag)).toEqual(["Queued", "Queued", "Queued", "TurnStarted"])
    expect(heard.flatMap((event) => event._tag === "UserMessage" ? [[event.turn, Option.getOrNull(event.id), event.text]] : []))
      .toEqual(sent.map((entry, index) => [index + 1, entry.id, entry.text]))
  })

  test("a rebuild keeps the conversation, and a changed system text and budget reach the next request", async () => {
    const { runtime } = await start()
    await (await runtime.send(["first"]))[0]?.outcome
    const edited = set(set(DEFAULT_AGENT, "system", "You are a pirate."), "budgetTokens", 900)
    expect(await runtime.rebuild(edited, DEFAULT_TINY)).toEqual({ _tag: "Built" })
    expect(await (await runtime.send(["second"]))[0]?.outcome).toEqual({ _tag: "Replied", text: "You said: \"second\". I can also see 2 earlier messages." })
    const sent = sentOf(await runtime.journal())
    expect(sent.map((request) => [request.system, Number(request.budgetTokens), request.messages.length])).toEqual([
      ["You are a friendly tutor. Keep answers short.", 3000, 1],
      ["You are a pirate.", 900, 3],
    ])
  })

  test("a rebuild asked for while a reply is unsettled waits for it, then builds the latest source", async () => {
    const { runtime } = await start()
    const [sent] = await runtime.send(["a message that takes a little while to answer"])
    expect(runtime.busy).toBe(true)
    let settled = false
    void sent?.outcome.then(() => { settled = true })
    const first = runtime.rebuild(set(DEFAULT_AGENT, "system", "First edit."), DEFAULT_TINY)
    const latest = runtime.rebuild(set(DEFAULT_AGENT, "system", "Latest edit."), DEFAULT_TINY)
    expect(await first).toEqual({ _tag: "Built" })
    expect(settled).toBe(true)
    expect(await latest).toEqual({ _tag: "Built" })
    await (await runtime.send(["next"]))[0]?.outcome
    expect(sentOf(await runtime.journal()).map((request) => request.system)).toEqual(["You are a friendly tutor. Keep answers short.", "Latest edit."])
  })

  test("two rebuilds asked for at once run one after the other, and only the latest agent takes messages", async () => {
    const { runtime } = await start()
    const pressured: Array<number> = []
    runtime.onEvent((event) => { if (event._tag === "WindowPressure") pressured.push(event.budgetTokens) })
    const first = runtime.rebuild(set(set(DEFAULT_AGENT, "system", "First."), "budgetTokens", 8), DEFAULT_TINY)
    const latest = runtime.rebuild(set(set(DEFAULT_AGENT, "system", "Latest."), "budgetTokens", 7), DEFAULT_TINY)
    expect([await first, await latest]).toEqual([{ _tag: "Built" }, { _tag: "Built" }])
    // 2 tokens of system text and 4 of message: over 80% of the budget of 7, so the window announces pressure.
    await (await runtime.send(["hi there friend"]))[0]?.outcome
    expect(sentOf(await runtime.journal()).map((request) => [request.system, Number(request.estimatedTokens)])).toEqual([["Latest.", 6]])
    // Only one window memory is listening: the first agent's was closed, so one pressure event is published, not two.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pressured).toEqual([7])
  })

  test("stop: the running turn ends Interrupted, waiting messages are stopped, and the session takes the next message", async () => {
    const { runtime } = await start()
    const answering = heardOnce(runtime, "Delta")
    const sent = await runtime.send(["tell me a long story about loops", "and another", "and a third"])
    await answering
    expect(await runtime.stop()).toEqual({ _tag: "Built" })
    expect(await Promise.all(sent.map((entry) => entry.outcome))).toEqual([{ _tag: "Stopped" }, { _tag: "Stopped" }, { _tag: "Stopped" }])
    expect(endsOf(await runtime.journal())).toEqual([{ turn: 1, outcome: { _tag: "Interrupted" } }])
    expect((await (await runtime.send(["again"]))[0]?.outcome)?._tag).toBe("Replied")
    expect(endsOf(await runtime.journal()).map((end) => end.outcome._tag)).toEqual(["Interrupted", "Completed"])
  })

  test("over the budget, the failure stays typed, with the estimate and the budget", async () => {
    const { runtime } = await start(set(DEFAULT_AGENT, "budgetTokens", 5))
    const outcome = await (await runtime.send(["hi"]))[0]?.outcome
    // 12 tokens of system text and 1 of message, over a budget of 5.
    expect(outcome).toMatchObject({ _tag: "OverBudget", estimatedTokens: 13, budgetTokens: 5 })
    expect(endsOf(await runtime.journal())).toEqual([{ turn: 1, outcome: { _tag: "Failed", reason: expect.stringContaining("OverBudget") } }])
  })

  test("without a memory the stack does not build, and says what is missing", async () => {
    const { runtime } = await start()
    const refused = await runtime.rebuild(Option.getOrThrow(withoutMemory(DEFAULT_AGENT)), DEFAULT_TINY)
    expect(refused).toMatchObject({ _tag: "Refused", message: expect.stringContaining("Memory") })
    expect(runtime.ready).toBe(false)
    expect(await (await runtime.send(["hi"]))[0]?.outcome).toEqual({ _tag: "Refused", message: "Build the agent first." })
  })

  test("text that is no layer, or no valid expression, is refused readably", async () => {
    const { runtime } = await start()
    expect(await runtime.rebuild("inbox.pipe(", DEFAULT_TINY)).toMatchObject({ _tag: "Refused", message: expect.stringContaining("not a valid expression") })
    expect(await runtime.rebuild("42", DEFAULT_TINY)).toEqual({ _tag: "Refused", message: "The agent must be a layer, such as inbox.pipe(...)." })
    expect(await runtime.rebuild("stepLoop", DEFAULT_TINY)).toMatchObject({ _tag: "Refused" })
  })

  test("a broken tiny-memory.ts is reported by file, only when the agent uses it", async () => {
    const { runtime } = await start()
    expect(await runtime.rebuild(DEFAULT_AGENT, "this is not (valid")).toEqual({ _tag: "Built" })
    const used = await runtime.rebuild(set(DEFAULT_AGENT, "memory", "last"), "this is not (valid")
    expect(used).toMatchObject({ _tag: "Refused", message: expect.stringContaining("tiny-memory.ts") })
  })

  test("the learner's memory swapped in over the same session sends only the last message", async () => {
    const { runtime } = await start()
    await (await runtime.send(["My name is Ana."]))[0]?.outcome
    expect(await runtime.rebuild(set(DEFAULT_AGENT, "memory", "last"), DEFAULT_TINY)).toEqual({ _tag: "Built" })
    expect(await (await runtime.send(["What did I just say?"]))[0]?.outcome).toEqual({ _tag: "Replied", text: "This is the first message, so I have nothing earlier to recall." })
    expect(sentOf(await runtime.journal()).map((request) => request.messages.length)).toEqual([1, 1])
  })

  test("clear starts a new, empty session in the same base", async () => {
    const { runtime } = await start()
    await (await runtime.send(["hello there"]))[0]?.outcome
    await runtime.clear()
    expect(await runtime.journal()).toEqual([])
    expect(await (await runtime.send(["after clearing"]))[0]?.outcome).toEqual({ _tag: "Replied", text: "You said: \"after clearing\". This is the start of the conversation." })
  })
})
