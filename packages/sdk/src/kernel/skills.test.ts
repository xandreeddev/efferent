import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { kernel, messageOf, Seq, Sessions, toolResult, TurnNumber, userMessage } from "@xandreed/core/kernel"
import type { OpenSession, SessionId, StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import {
  callTool, catalogue, defineSkill, flatMemory, inProcessJournal, loadedOf, LoadSkill, Memory, memoryWrapperConformance, modelAnswer, promptMessage, scriptedModel, sessions,
  skills,
} from "./index.js"
import type { ModelScript } from "./index.js"

/** The ids of the checks of a kit that fail. */
const failedChecks = (checks: ReadonlyArray<{ readonly id: string; readonly run: Effect.Effect<void, unknown> }>) =>
  Effect.runPromise(Effect.forEach(checks, (check) => Effect.map(Effect.exit(check.run), (exit) => (exit._tag === "Failure" ? [check.id] : [])), { concurrency: 1 })).then((all) => all.flat())

/*
 * Skills (ADR 0013), as a test: instructions and tools the model is not
 * sent until it asks. A skill is loaded by a tool call, its instructions
 * are that call's stored result, and which tools are offered is a fold of
 * the journal. `docs/kernel.md` quotes the skills and the loop.
 */

// #region skills
// A tool the agent always has.
const Add = Tool.make("add", { parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }), success: Schema.Number, failure: Schema.String, failureMode: "return" })
const tools = Toolkit.make(Add)
const toolsLive = tools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })

// A skill with a tool of its own: neither its instructions nor its tool is sent until the model loads it.
const Convert = Tool.make("convert", {
  description: "Convert a length from one unit to another.",
  parameters: Schema.Struct({ value: Schema.Number, from: Schema.Literals(["km", "mi"]), to: Schema.Literals(["km", "mi"]) }),
  success: Schema.Number,
  failure: Schema.String,
  failureMode: "return",
})
const units = defineSkill({
  id: "units",
  summary: "Convert a length between kilometres and miles.",
  instructions: "Convert with the convert tool, never in your head.\nAnswer with the number and its unit, to one decimal.",
  tools: Toolkit.make(Convert),
})
const unitsLive = units.tools.toLayer({
  convert: ({ value, from, to }) => Effect.succeed(from === to ? value : from === "km" ? value / 1.609344 : value * 1.609344),
})

// A skill that is instructions alone.
const haiku = defineSkill({ id: "haiku", summary: "Answer in a haiku.", instructions: "Answer in three lines of five, seven and five syllables.", tools: Toolkit.empty })

// One value over the tools and the skills: the whole toolkit, the catalogue, loadSkill's handler and what to offer.
const skillSet = skills(tools, units, haiku)
const handlers = Layer.mergeAll(toolsLive, unitsLive, skillSet.handlers)
const SYSTEM = `Use a tool when it helps.\n\n${skillSet.catalogue}`
// #endregion skills

/** Drafts as a journal's records, in order, for a rule that reads a journal. */
const journalOf = (drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> =>
  drafts.map((draft, index) => ({ ...draft, seq: Seq.make(index + 1), at: 1_767_225_600_000, turn: TurnNumber.make(1) }))

/** What a step offered, and what the model was sent. */
interface Ran {
  readonly journal: ReadonlyArray<StoredEvent>
  readonly offered: ReadonlyArray<ReadonlyArray<string>>
  readonly sent: ReadonlyArray<ReadonlyArray<{ readonly role: string; readonly text: string }>>
}

/** A host's turn over the skills, one message a turn: the journal after, the tools each step offered, and what the model was sent. */
const run = (script: ModelScript, messages: ReadonlyArray<string>, set: Pick<typeof skillSet, "offered" | "withReloadNote"> = skillSet, memory: Layer.Layer<Memory> = flatMemory): Effect.Effect<Ran> => Effect.gen(function* () {
  const { model, calls: sent } = yield* scriptedModel(script)
  const offered: Array<ReadonlyArray<string>> = []
  // #region loop
  const turn = (conversation: SessionId, message: string) => Effect.scoped(Effect.gen(function* () {
    const memory = yield* Memory
    const language = yield* LanguageModel.LanguageModel
    const session = yield* (yield* Sessions).open(conversation)
    yield* session.append(userMessage(message))
    for (let step = 1; step <= 5; step++) {
      // What is offered is read from the journal at each step: the tools no skill owns, and each loaded skill's.
      const toolkit = yield* set.offered(yield* session.journal)
      offered.push(Object.keys(toolkit.tools))
      const prompt = Prompt.make([{ role: "system", content: SYSTEM }, ...(yield* memory.context(session))])
      const answer = yield* modelAnswer(language.streamText({ prompt, toolkit, disableToolCallResolution: true, toolCallValidation: "deferred" }), session)
      if (answer.toolCalls.length === 0) return answer.text
      // The same toolkit runs the calls: a tool that was not offered is not run.
      for (const call of answer.toolCalls) yield* callTool(toolkit, call, session)
    }
    return "stopped"
  }))
  // #endregion loop
  const journal = yield* Effect.gen(function* () {
    const all = yield* Sessions
    const conversation = yield* all.create({ owner: "test" })
    yield* Effect.forEach(messages, (message) => turn(conversation, message), { concurrency: 1, discard: true })
    return (yield* all.read(conversation)).events
  }).pipe(Effect.provide(Layer.mergeAll(model, handlers, set.withReloadNote(memory), sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel())))), Effect.orDie)
  return { journal, offered, sent: yield* sent }
})

const calls = (...made: ReadonlyArray<{ readonly name: string; readonly params: Schema.Json }>) => ({ _tag: "Calls" as const, pieces: [], calls: made })
const says = (text: string) => ({ _tag: "Answers" as const, pieces: [text] })
const load = (skill: string) => ({ name: "loadSkill", params: { skill } })
const convert = { name: "convert", params: { value: 5, from: "km", to: "mi" } }
const results = (journal: ReadonlyArray<StoredEvent>) =>
  journal.flatMap((record) => Option.toArray(messageOf(record))).flatMap((message) => (message._tag === "ToolResult" ? [[message.name, message.result, message.isFailure]] : []))

const UNITS_LOADED = { skill: "units", instructions: "Convert with the convert tool, never in your head.\nAnswer with the number and its unit, to one decimal." }
const CATALOGUE = [
  "You have skills: instructions and tools you are not given until you load them. Before you do something a skill covers, call loadSkill with its name and follow what it returns.",
  "- units: Convert a length between kilometres and miles.",
  "- haiku: Answer in a haiku.",
].join("\n")

describe("skills", () => {
  test("a skill is loaded by a call: its instructions are the call's result, and its tool is offered from the next step", async () => {
    // #region load
    const { journal, offered, sent } = await Effect.runPromise(run([calls(load("units")), calls(convert), says("3.1 miles.")], ["How far is 5 km in miles?"]))
    // Before the skill is loaded the model is offered the base tool and loadSkill; after, the skill's tool too.
    expect(offered).toEqual([["add", "loadSkill"], ["add", "loadSkill", "convert"], ["add", "loadSkill", "convert"]])
    // Loading stored nothing of its own: the call and its result, which is the skill's instructions, kept whole.
    expect(journal.map((record) => String(record.name))).toEqual([
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "conversation.tool.result",
      "conversation.assistant.message", "conversation.tool.result", "conversation.assistant.message", "core.session.turn.ended",
    ])
    expect(results(journal)).toEqual([["loadSkill", UNITS_LOADED, false], ["convert", 5 / 1.609344, false]])
    // The skill is loaded because that result is stored.
    expect(loadedOf(journal).map(String)).toEqual(["units"])
    // #endregion load
    expect(journal.flatMap((record) => Option.toArray(messageOf(record))).flatMap((message) => (message._tag === "ToolResult" ? [message.whole] : []))).toEqual([true, undefined])
    // What the model read: the catalogue in the system text every time, and the instructions as the tool's answer from the second call on.
    expect(sent.map((prompt) => prompt[0])).toEqual([{ role: "system", text: SYSTEM }, { role: "system", text: SYSTEM }, { role: "system", text: SYSTEM }])
    expect(sent[1]?.slice(1)).toEqual([
      { role: "user", text: "How far is 5 km in miles?" },
      { role: "assistant", text: 'loadSkill({"skill":"units"})' },
      { role: "tool", text: `→ ${JSON.stringify(UNITS_LOADED)}` },
    ])
  })

  test("the catalogue names every skill with its line, and says nothing of which are loaded", () => {
    expect(skillSet.catalogue).toBe(CATALOGUE)
    expect(catalogue([units, haiku])).toBe(CATALOGUE)
  })

  test("loadSkill says what loading gives, and its parameter is the skill's name", () => {
    expect(LoadSkill.description).toBe("Load a skill: returns the skill's instructions, and from your next step its tools are yours to call. Load a skill before you do what it covers. Loading one again returns its instructions again.")
    expect(Tool.getJsonSchema(LoadSkill)).toMatchObject({ properties: { skill: { type: "string", description: "The skill's name." } }, required: ["skill"] })
  })

  test("a tool of a skill that is not loaded is not run: the call fails as a call of an unknown tool does, also in the step that loads it", async () => {
    const { journal, offered } = await Effect.runPromise(run([calls(convert), calls(load("units"), convert), calls(convert), says("3.1 miles.")], ["How far is 5 km in miles?"]))
    expect(results(journal)).toEqual([
      ["convert", "Toolkit.convert.handle: Tool 'convert' not found. Available tools: add, loadSkill", true],
      ["loadSkill", UNITS_LOADED, false],
      // Asked for in the same step as its load: what is offered was read before the step, so it is not there yet.
      ["convert", "Toolkit.convert.handle: Tool 'convert' not found. Available tools: add, loadSkill", true],
      ["convert", 5 / 1.609344, false],
    ])
    expect(offered).toEqual([["add", "loadSkill"], ["add", "loadSkill"], ["add", "loadSkill", "convert"], ["add", "loadSkill", "convert"]])
  })

  test("an unknown skill fails with the names there are; loading a skill again answers again, and it is loaded once", async () => {
    const { journal, offered } = await Effect.runPromise(run([calls(load("unit")), calls(load("units")), calls(load("units")), says("Loaded.")], ["Load the unit skill."]))
    expect(results(journal)).toEqual([
      ["loadSkill", 'No skill is named "unit". The skills are: units, haiku.', true],
      ["loadSkill", UNITS_LOADED, false],
      ["loadSkill", UNITS_LOADED, false],
    ])
    expect(loadedOf(journal).map(String)).toEqual(["units"])
    expect(offered.at(-1)).toEqual(["add", "loadSkill", "convert"])
  })

  test("a skill that is instructions alone loads the same way and offers no tool; another conversation has nothing loaded", async () => {
    const { journal, offered } = await Effect.runPromise(run([calls(load("haiku")), says("Leaves fall.")], ["Tell me about autumn."]))
    expect(results(journal)).toEqual([["loadSkill", { skill: "haiku", instructions: "Answer in three lines of five, seven and five syllables." }, false]])
    expect(loadedOf(journal).map(String)).toEqual(["haiku"])
    expect(offered).toEqual([["add", "loadSkill"], ["add", "loadSkill"]])
    // A conversation of its own starts with nothing loaded: what is loaded is its journal's.
    const other = await Effect.runPromise(run([says("Hello.")], ["Hello."]))
    expect([loadedOf(other.journal).map(String), other.offered]).toEqual([[], [["add", "loadSkill"]]])
  })

  test("tools are offered in the order their skills were loaded, after the tools no skill owns, and a loaded tool stays", async () => {
    const Weekday = Tool.make("weekday", { parameters: Schema.Struct({ date: Schema.String }), success: Schema.String, failure: Schema.String, failureMode: "return" })
    const Today = Tool.make("today", { success: Schema.String, failure: Schema.String, failureMode: "return" })
    const dates = defineSkill({ id: "dates", summary: "Work with dates.", instructions: "Use weekday for a date's day.", tools: Toolkit.make(Weekday, Today) })
    const both = skills(tools, units, dates)
    const datesLive = dates.tools.toLayer({ weekday: () => Effect.succeed("Sunday"), today: () => Effect.succeed("2026-11-15") })
    // The journal of a conversation that loaded dates, then units: the two results, as `callTool` stores them.
    const journal = journalOf([
      userMessage("Load both."),
      toolResult({ id: "c1", name: "loadSkill" }, { skill: "dates", instructions: dates.instructions }, false, { whole: true }),
      toolResult({ id: "c2", name: "loadSkill" }, { skill: "units", instructions: units.instructions }, false, { whole: true }),
    ])
    const order = await Effect.runPromise(Effect.gen(function* () {
      const all = yield* both.offered(journal)
      const first = yield* both.offered(journal.slice(0, 2))
      return { loaded: loadedOf(journal).map(String), all: Object.keys(all.tools), first: Object.keys(first.tools), whole: Object.keys(both.toolkit.tools) }
    }).pipe(Effect.provide(Layer.mergeAll(toolsLive, unitsLive, datesLive, both.handlers))))
    expect(order).toEqual({
      loaded: ["dates", "units"],
      // dates was loaded first, so its tools come before the units skill's, though the whole toolkit has units first.
      all: ["add", "loadSkill", "weekday", "today", "convert"],
      first: ["add", "loadSkill", "weekday", "today"],
      whole: ["add", "loadSkill", "convert", "weekday", "today"],
    })
  })

  test("a journal that names a skill the host no longer has is read without it: its tools are not offered, and nothing fails", async () => {
    const { journal } = await Effect.runPromise(run([calls(load("units")), says("Loaded.")], ["Load units."]))
    const fewer = skills(tools, haiku)
    const offered = await Effect.runPromise(Effect.map(fewer.offered(journal), (toolkit) => Object.keys(toolkit.tools)).pipe(Effect.provide(Layer.mergeAll(toolsLive, fewer.handlers))))
    expect(loadedOf(journal).map(String)).toEqual(["units"])
    expect(offered).toEqual(["add", "loadSkill"])
  })
})

/** A memory that sends the open turn's message and nothing before it: what a window or a compaction leaves of an old load. */
const lastMessageOnly: Layer.Layer<Memory> = Layer.succeed(Memory, Memory.of({
  context: (session: OpenSession) => Effect.map(session.journal, (journal) =>
    journal.flatMap((record) => Option.toArray(messageOf(record))).filter((message) => message._tag === "User").slice(-1).map(promptMessage)),
}))

describe("a loaded skill whose instructions a memory no longer sends", () => {
  const NOTE = "[Host note: these skills are loaded, and their instructions are no longer in this conversation: units. Call loadSkill again with a skill's name to read its instructions before you use it.]"

  test("the wrapper adds one note for the request, last, naming the skill and how to read it again; its tools stay offered", async () => {
    const { sent, offered, journal } = await Effect.runPromise(run([calls(load("units")), says("Loaded."), says("One moment.")], ["Load units.", "How far is 5 km?"], skillSet, lastMessageOnly))
    // While the load's result is not in what the memory sends, the note follows the context.
    expect(sent[2]?.slice(1)).toEqual([{ role: "user", text: "How far is 5 km?" }, { role: "user", text: NOTE }])
    expect(offered.at(-1)).toEqual(["add", "loadSkill", "convert"])
    // It is said for the request and not stored: the journal holds the two turns and no note.
    expect(journal.flatMap((record) => Option.toArray(messageOf(record))).filter((message) => message._tag === "User").map((message) => message.text)).toEqual(["Load units.", "How far is 5 km?"])
  })

  test("while the memory still sends the instructions, nothing is added", async () => {
    const { sent } = await Effect.runPromise(run([calls(load("units")), says("Loaded."), says("One moment.")], ["Load units.", "How far is 5 km?"]))
    expect(sent[2]?.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"])
    expect(sent[2]?.some((message) => message.text.includes("Host note"))).toBe(false)
  })

  test("a loaded skill the host no longer has is not named, and with none to name nothing is added", async () => {
    const fewer = skills(tools, haiku)
    const { sent } = await Effect.runPromise(run([calls(load("units")), says("Loaded."), says("One moment.")], ["Load units.", "How far is 5 km?"], { offered: skillSet.offered, withReloadNote: fewer.withReloadNote }, lastMessageOnly))
    expect(sent[2]?.slice(1)).toEqual([{ role: "user", text: "How far is 5 km?" }])
  })

  test("the wrapper passes the memory wrapper kit: what it adds comes after the context below, and it stores nothing", async () => {
    expect(await failedChecks(memoryWrapperConformance({ name: "skills", wrap: skillSet.withReloadNote }))).toEqual([])
  })
})

describe("skills that make no set are refused where they are written", () => {
  const Other = Tool.make("convert", { success: Schema.String, failure: Schema.String, failureMode: "return" })
  const skill = (id: string, summary = "Convert.", instructions = "Convert.") => () => defineSkill({ id, summary, instructions, tools: Toolkit.empty })

  test("a skill's id, summary and instructions", () => {
    expect(skill("Units")).toThrow('a skill\'s id is lower-case words joined by hyphens, at most 64 characters, such as "unit-converter": "Units" is none')
    expect(skill("units", " ")).toThrow("the skill units needs a summary of one line, 1 to 200 characters: it is the skill's line in the catalogue")
    expect(skill("units", "Two\nlines.")).toThrow("the skill units needs a summary of one line, 1 to 200 characters: it is the skill's line in the catalogue")
    expect(skill("units", "x".repeat(201))).toThrow("the skill units needs a summary of one line, 1 to 200 characters: it is the skill's line in the catalogue")
    expect(skill("units", "Convert.", "\n")).toThrow("the skill units needs instructions: they are what loading it gives the model")
    expect(skill("unit-converter-2")).not.toThrow()
  })

  test("no skill, two skills with one name, and a tool that two of the base, the kernel and the skills have", () => {
    const again = defineSkill({ id: "units", summary: "Again.", instructions: "Again.", tools: Toolkit.empty })
    const lengths = defineSkill({ id: "lengths", summary: "Lengths.", instructions: "Convert.", tools: Toolkit.make(Other) })
    const loader = defineSkill({ id: "loader", summary: "Loads.", instructions: "Load.", tools: Toolkit.make(LoadSkill) })
    expect(() => skills(tools)).toThrow("skills needs at least one skill: skills(tools, defineSkill({ … }))")
    expect(() => skills(tools, units, again)).toThrow("two skills are named units: a skill is loaded by its name")
    expect(() => skills(tools, units, lengths)).toThrow("the tool convert is in the skill units and in the skill lengths: a tool belongs to one skill, or to none")
    expect(() => skills(Toolkit.make(Add, Other), units)).toThrow("the tool convert is in the base toolkit and in the skill units: a tool belongs to one skill, or to none")
    expect(() => skills(tools, loader)).toThrow("the tool loadSkill is in the kernel and in the skill loader: a tool belongs to one skill, or to none")
    expect(() => skills(tools, units, haiku)).not.toThrow()
  })

  test("a skill written by hand, as untyped code writes one, is checked as defineSkill checks it", () => {
    // What untyped code can hand over: an object that was never through defineSkill, with whatever it holds.
    const byHand = (skill: unknown) => () => Reflect.apply(skills, undefined, [tools, skill])
    expect(byHand({ id: "Units", summary: "Convert.", instructions: "Convert.", tools: Toolkit.empty })).toThrow('a skill\'s id is lower-case words joined by hyphens, at most 64 characters, such as "unit-converter": "Units" is none')
    expect(byHand({ id: "units", summary: "", instructions: "Convert.", tools: Toolkit.empty })).toThrow("the skill units needs a summary of one line, 1 to 200 characters: it is the skill's line in the catalogue")
    expect(byHand({ id: "units", summary: "Convert.", tools: Toolkit.empty })).toThrow("the skill units needs instructions: they are what loading it gives the model")
    expect(byHand({ id: "units", summary: "Convert.", instructions: "Convert." })).toThrow("the skill units needs tools, a toolkit: Toolkit.make(…) of its own tools, or Toolkit.empty when it has none")
    expect(byHand("units")).toThrow("a skill is made with defineSkill({ id, summary, instructions, tools })")
    expect(byHand({ id: 7, summary: "Convert.", instructions: "Convert.", tools: Toolkit.empty })).toThrow('a skill\'s id is lower-case words joined by hyphens, at most 64 characters, such as "unit-converter": "7" is none')
    expect(() => Reflect.apply(skills, undefined, [undefined, units])).toThrow("skills needs the host's toolkit first: skills(tools, …), with Toolkit.empty when it has no tool of its own")
    // One that fits is taken as it is.
    expect(byHand({ id: "units", summary: "Convert.", instructions: "Convert.", tools: Toolkit.empty })).not.toThrow()
  })
})
