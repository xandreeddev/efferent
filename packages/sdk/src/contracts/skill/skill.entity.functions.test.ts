import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import type { Prompt } from "effect/ai"
import { assistantMessage, Seq, ToolCallId, toolResult, TurnNumber, userMessage } from "@xandreed/core"
import type { StoredDraft, StoredEvent } from "@xandreed/core"
import { defineSkill, instructionsIn, loadedOf, noSkillNamed, offeredBy, rankOf, reloadNote } from "./skill.entity.functions.js"
import { SkillId } from "./skill.entity.js"

const journalOf = (drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> =>
  drafts.map((draft, index) => ({ ...draft, seq: Seq.make(index + 1), at: 1_767_225_600_000, turn: TurnNumber.make(1) }))
const loaded = (id: string, skill: unknown, isFailure = false, name = "loadSkill") => toolResult({ id, name }, skill, isFailure, { whole: true })
const ids = (...names: ReadonlyArray<string>) => names.map((name) => SkillId.make(name))

describe("the skills loaded in a journal", () => {
  test("loadedOf is each skill a stored result of loadSkill names, once, in the order first loaded", () => {
    expect(loadedOf(journalOf([
      userMessage("go"),
      assistantMessage("", { toolCalls: [{ id: ToolCallId.make("c1"), name: "loadSkill", params: { skill: "dates" } }] }),
      loaded("c1", { skill: "dates", instructions: "Use weekday." }),
      loaded("c2", { skill: "units", instructions: "Convert." }),
      loaded("c3", { skill: "dates", instructions: "Use weekday." }),
    ])).map(String)).toEqual(["dates", "units"])
    expect(loadedOf([])).toEqual([])
  })

  test("a failed load, another tool's result, and a result that is no loaded skill load nothing", () => {
    expect(loadedOf(journalOf([
      // The call was made and failed: an unknown name, or a tool not offered.
      loaded("c1", 'No skill is named "unit". The skills are: units.', true),
      // Another tool that answers in the same shape: only loadSkill's results count.
      loaded("c2", { skill: "units", instructions: "Convert." }, false, "lookup"),
      // Not the shape loadSkill answers in: no instructions, a name that is no skill's id, a text.
      loaded("c3", { skill: "units" }),
      loaded("c4", { skill: "Not A Skill", instructions: "Convert." }),
      loaded("c5", "units"),
      // A model's call that has no result yet loads nothing: the result is what is stored of a load.
      assistantMessage("", { toolCalls: [{ id: ToolCallId.make("c6"), name: "loadSkill", params: { skill: "units" } }] }),
    ]))).toEqual([])
  })
})

describe("the instructions a context still holds", () => {
  const result = (name: string, value: unknown, isFailure = false): Prompt.MessageEncoded => ({ role: "tool", content: [{ type: "tool-result", id: "c1", name, isFailure, result: value }] })

  test("instructionsIn is each skill a result of loadSkill in the context names; failures, other tools and other messages hold none", () => {
    expect(instructionsIn([
      { role: "user", content: 'loadSkill {"skill":"haiku","instructions":"Three lines."}' },
      result("loadSkill", { skill: "units", instructions: "Convert." }),
      result("loadSkill", 'No skill is named "unit".', true),
      result("lookup", { skill: "dates", instructions: "Use weekday." }),
      { role: "assistant", content: "Loaded." },
    ]).map(String)).toEqual(["units"])
    expect(instructionsIn([])).toEqual([])
  })

  test("the note names the skills whose instructions are gone, and how to read them again, and holds no instructions", () => {
    expect(reloadNote(ids("units", "dates"))).toBe("[Host note: these skills are loaded, and their instructions are no longer in this conversation: units, dates. Call loadSkill again with a skill's name to read its instructions before you use it.]")
  })

  test("an unknown skill's failure names what was asked for and the skills there are", () => {
    const skills = [defineSkill({ id: "units", summary: "Convert.", instructions: "Convert.", tools: Toolkit.empty }), defineSkill({ id: "haiku", summary: "Haiku.", instructions: "Three lines.", tools: Toolkit.empty })]
    expect(noSkillNamed("unit", skills)).toBe('No skill is named "unit". The skills are: units, haiku.')
  })

  test("a long name the model sent is cut in the failure, with what was cut counted, and never mid-character", () => {
    const skills = [defineSkill({ id: "units", summary: "Convert.", instructions: "Convert.", tools: Toolkit.empty })]
    expect(noSkillNamed("x".repeat(64), skills)).toBe(`No skill is named "${"x".repeat(64)}". The skills are: units.`)
    expect(noSkillNamed("x".repeat(5000), skills)).toBe(`No skill is named "${"x".repeat(64)}" [… 4936 characters clipped]. The skills are: units.`)
    expect(noSkillNamed(`${"x".repeat(63)}🌊tail`, skills)).toBe(`No skill is named "${"x".repeat(63)}" [… 6 characters clipped]. The skills are: units.`)
  })
})

describe("what is offered", () => {
  const Add = Tool.make("add", { success: Schema.Number })
  const Convert = Tool.make("convert", { success: Schema.Number })
  const Weekday = Tool.make("weekday", { success: Schema.String })
  const Today = Tool.make("today", { success: Schema.String })
  const units = defineSkill({ id: "units", summary: "Convert.", instructions: "Convert.", tools: Toolkit.make(Convert) })
  const dates = defineSkill({ id: "dates", summary: "Dates.", instructions: "Use weekday.", tools: Toolkit.make(Weekday, Today) })
  const whole = Toolkit.make(Add, Convert, Weekday, Today)
  const live = whole.toLayer({ add: () => Effect.succeed(1), convert: () => Effect.succeed(1), weekday: () => Effect.succeed("Sunday"), today: () => Effect.succeed("2026-11-15") })
  const names = (placeOf: (tool: string) => Option.Option<number>) =>
    Effect.runPromise(Effect.map(offeredBy(whole, placeOf), (toolkit) => Object.keys(toolkit.tools)).pipe(Effect.provide(live)))

  test("rankOf places a tool no skill owns first, a loaded skill's tool at its skill's place, and an unloaded skill's nowhere", () => {
    const rank = rankOf([units, dates], ids("dates", "gone", "units"))
    expect([rank("add"), rank("weekday"), rank("today"), rank("convert")]).toEqual([Option.some(0), Option.some(1), Option.some(1), Option.some(3)])
    const none = rankOf([units, dates], [])
    expect([none("add"), none("convert"), none("weekday")]).toEqual([Option.some(0), Option.none(), Option.none()])
    // A name every object has is no tool of a skill: it is placed with the tools no skill owns.
    expect(none("constructor")).toEqual(Option.some(0))
  })

  test("offeredBy keeps the tools that have a place, in the order of their places, and within one place the whole's order", async () => {
    expect(await names(rankOf([units, dates], []))).toEqual(["add"])
    expect(await names(rankOf([units, dates], ids("units")))).toEqual(["add", "convert"])
    expect(await names(rankOf([units, dates], ids("dates", "units")))).toEqual(["add", "weekday", "today", "convert"])
    expect(await names(rankOf([units, dates], ids("units", "dates")))).toEqual(["add", "convert", "weekday", "today"])
    expect(await names(() => Option.none())).toEqual([])
  })
})
