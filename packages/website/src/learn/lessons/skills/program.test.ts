// Lesson 10's five files, compiled as written, type-checked, and run on the
// kernel with a scripted model: the model loads a skill with a call, the
// skill's tool is offered from the next step, a call made before the load
// fails as a call of an unknown tool, and a skill that is instructions alone
// adds no tool. What the model was sent is read from the typed module's run;
// which tools each step offered is read from the same text and script on the
// page's runtime, which hears the toolkit a loop hands the model. Each text
// the lesson derives is checked against the text it starts from, and the
// program that leaves out a skill's handlers is checked not to compile.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import { LanguageModel } from "effect/ai"
import { scriptedModel } from "@xandreed/sdk"
import type { ModelScript } from "@xandreed/sdk"
import { BASE_AGENT, IMPORTS as BASE_IMPORTS } from "../base/agent.source.ts"
import { LessonRuntime } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, documentOf, IMPORTS, LOADER_LINE, moduleOf, OFFERED, OPENING, REPLACED, REPLACED_IMPORTS, SYSTEM as SYSTEM_LINES, UNITS_LINE } from "./agent.source.ts"
import { alwaysOn, noCatalogue, noHandlers, NO_UNITS_LINE, SYSTEM_ALONE, SYSTEM_WITH_INSTRUCTIONS, WHOLE_TOOLKIT } from "./config-edit.ts"
import { skillsLesson } from "./lesson.ts"
import { DEFAULT_SKILLS, HAIKU, SKILL_SET, SKILLS_IMPORTS, skillsDocumentOf, skillsModuleOf, UNITS } from "./skills.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

interface Shown {
  readonly replies: ReadonlyArray<string>
  readonly errors: ReadonlyArray<string>
  readonly status: ReadonlyArray<string>
}

const write = (name: string, agent: string = DEFAULT_AGENT) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(agent))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./skills.ts", at), skillsModuleOf(DEFAULT_SKILLS))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(DEFAULT_TOOLS))
  return new URL("./agent.ts", at)
}

type Pane = { readonly onSend: (send: (text: string) => void) => void; readonly appendToAnswer: (piece: string) => void; readonly finishAnswer: (text: string) => void; readonly showError: (error: unknown) => void; readonly showStatus: (text: string) => void }
type Run = (pane: Pane, model: Layer.Layer<LanguageModel.LanguageModel>) => Effect.Effect<void, unknown>

/**
 * Run `main` from the module at `file` with the scripted model. `messages` are sent one by one, each once the one
 * before it is answered; it stops when each has its reply or its error. What comes back: what was shown, and
 * every prompt the model received.
 */
const runMain = (file: URL, messages: ReadonlyArray<string>, script: ModelScript) => Effect.gen(function* () {
  const { run }: { readonly run: Run } = yield* Effect.promise(() => import(file.href))
  const { model, calls } = yield* scriptedModel(script)
  const shown = yield* Ref.make<Shown>({ replies: [], errors: [], status: [] })
  const done = yield* Deferred.make<void>()
  const sent = yield* Deferred.make<(text: string) => void>()
  let send: (text: string) => void = () => {}
  const note = (key: keyof Shown, text: string) => Effect.runSync(Ref.update(shown, (all) => ({ ...all, [key]: [...all[key], text] })))
  // One more answer is there: the next message goes, or the run is over.
  const answered = () => {
    const count = Effect.runSync(Effect.map(Ref.get(shown), (all) => all.replies.length + all.errors.length))
    const next = messages[count]
    if (next === undefined) Effect.runSync(Deferred.succeed(done, undefined))
    else send(next)
  }
  const pane: Pane = {
    onSend: (given) => { send = given; Effect.runSync(Deferred.succeed(sent, given)) },
    appendToAnswer: () => {},
    finishAnswer: (text) => { note("replies", text); answered() },
    showError: (error) => { note("errors", String(error)); answered() },
    showStatus: (text) => note("status", text),
  }
  const program = yield* Effect.forkChild(run(pane, model))
  const given = yield* Deferred.await(sent)
  given(messages[0] ?? "")
  yield* Deferred.await(done)
  yield* Fiber.interrupt(program)
  return { shown: yield* Ref.get(shown), calls: yield* calls }
}).pipe(Effect.scoped, Effect.timeout("10 seconds"))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })
const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const STARTERS: Record<string, string> = Object.fromEntries(skillsLesson.files.map((file) => [file.id, file.defaultText]))

/**
 * The same text as the page runs it, on the page's runtime with the same scripted model: the tools each model call
 * was offered, in order. The page hears the toolkit a loop hands `streamText`; the scripted model records only the
 * prompt. Each message is sent once the one before is answered.
 */
const offeredOnThePage = async (messages: ReadonlyArray<string>, script: ModelScript, agent: string = DEFAULT_AGENT): Promise<ReadonlyArray<ReadonlyArray<string>>> => {
  const runtime = await LessonRuntime.create(skillsLesson)
  opened.push(runtime)
  const scripted = await Effect.runPromise(scriptedModel(script))
  const model = await Effect.runPromise(Effect.scoped(Effect.map(Layer.build(scripted.model), (built) => Context.get(built, LanguageModel.LanguageModel))))
  runtime.setModel({ choice: { id: "scripted", kind: "echo", label: "Scripted", blurb: "A model that follows a script.", memoryMB: 0 }, model, interrupt: () => {}, dispose: () => {} })
  const heard: Array<Trace> = []
  runtime.onTrace((trace) => heard.push(trace))
  expect(await runtime.start({ ...STARTERS, agent })).toEqual({ _tag: "Built" })
  for (const message of messages) {
    const answered = new Promise<void>((resolve) => { const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply" || trace._tag === "Failed" || trace._tag === "Ended") { stop(); resolve() } }) })
    runtime.send(message)
    await answered
  }
  return heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace.tools] : []))
}

const OPENING_TEXT = "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."
/** The catalogue as the kernel writes it for this lesson's two skills. */
const CATALOGUE = [
  "You have skills: instructions and tools you are not given until you load them. Before you do something a skill covers, call loadSkill with its name and follow what it returns.",
  "- units: Convert a length between kilometres and miles.",
  "- haiku: Answer in a haiku.",
].join("\n")
const SYSTEM = `${OPENING_TEXT}\n\n${CATALOGUE}`
const UNITS_INSTRUCTIONS = "Convert with the convert tool, never in your head.\nGive it the number as it was written, and each unit as km or mi.\nAnswer with the number and its unit, to one decimal."
const HAIKU_INSTRUCTIONS = "Answer in a haiku: three lines of five, seven and five syllables.\nWrite about what the message names. Add no title and no comment."

/** The tools no skill owns, with the kernel's loadSkill: what a step offers before any skill is loaded. */
const BASE = ["calculator", "remember", "recall", "loadSkill"]
const NOT_FOUND = "Toolkit.convert.handle: Tool 'convert' not found. Available tools: calculator, remember, recall, loadSkill"

const calls = (...made: ReadonlyArray<{ readonly name: string; readonly params: Record<string, string | number> }>) => ({ _tag: "Calls" as const, pieces: [], calls: made })
const says = (text: string) => ({ _tag: "Answers" as const, pieces: [text] })
const load = (skill: string) => ({ name: "loadSkill", params: { skill } })
const convert = { name: "convert", params: { value: 5, from: "km", to: "mi" } }
const loadedResult = (skill: string, instructions: string) => ({ role: "tool", text: `→ ${JSON.stringify({ skill, instructions })}` })

/** The lines of `after` that `before` has not, and the lines of `before` that `after` has not. */
const changed = (before: string, after: string) => ({
  gone: before.split("\n").filter((line) => !after.split("\n").includes(line)),
  come: after.split("\n").filter((line) => !before.split("\n").includes(line)),
})

describe("lesson 10's displayed program", () => {
  test("the base program still holds what this lesson replaces in it, and nothing else differs", () => {
    for (const [from] of REPLACED) expect({ from, held: BASE_AGENT.split(from).length - 1 }).toEqual({ from, held: 1 })
    for (const [from] of REPLACED_IMPORTS) expect({ from, held: BASE_IMPORTS.split(from).length - 1 }).toEqual({ from, held: 1 })
    // agent.ts beside the base: the system text under two names, where the toolkit is read, and two lines of main.
    expect(changed(BASE_AGENT, DEFAULT_AGENT)).toEqual({
      gone: ["const system =", "      const toolkit = yield* tools"],
      come: [
        "const opening =",
        "// It ends with the catalogue: one line per skill, and how to load one. The catalogue names every",
        "// skill and says nothing of which are loaded, so the system text is the same in every prompt.",
        "const system = `${opening}\\n\\n${skillSet.catalogue}`",
        "        // What is offered is read from the journal at each step: the tools no skill owns, then each",
        "        // loaded skill's. The same toolkit goes to the model and to callTool.",
        "        const toolkit = yield* skillSet.offered(yield* session.journal)",
        "  Effect.provide(unitsLive), // what the units skill's tool does, loaded or not",
        "  Effect.provide(skillSet.handlers), // what loadSkill does: it answers a skill's instructions",
      ],
    })
    expect(DEFAULT_AGENT).toContain(`${OPENING}\n${SYSTEM_LINES}`)
    // What to offer is read as each step starts, before the context: the first lines of the loop's body.
    expect(DEFAULT_AGENT).toContain(`      for (let step = 1; step <= MAX_STEPS; step++) {\n${OFFERED}        const history = yield* memory.context(session)\n`)
    // The same toolkit goes to the model and to callTool: the base's two uses of the name, unchanged.
    expect(DEFAULT_AGENT).toContain("            toolkit,\n")
    expect(DEFAULT_AGENT).toContain("          yield* callTool(toolkit, call, session)\n")
    // The two modules are given to the program, right after the tools' handlers.
    expect(DEFAULT_AGENT).toContain(`  Effect.provide(toolsLive), // what each tool does when it is called\n${UNITS_LINE}${LOADER_LINE}`)
    // Its imports beside the base's: skills.ts's four names, and tools.ts's handlers without its toolkit.
    expect(changed(BASE_IMPORTS, IMPORTS)).toEqual({
      gone: ['import { tools, toolsLive } from "./tools.ts"'],
      come: ['import { haiku, skillSet, units, unitsLive } from "./skills.ts"', 'import { toolsLive } from "./tools.ts"'],
    })
    // The program as it starts names neither skill: only the always-on experiment does.
    expect(DEFAULT_AGENT).not.toMatch(/\b(?:units|haiku)\b(?!Live| skill)/)
    expect(documentOf(DEFAULT_AGENT).startsWith(`${IMPORTS}\n\n// The system text`)).toBe(true)
  })

  test("skills.ts is the two skills and the one value over them and tools.ts's toolkit; tools.ts and memory.ts are lesson 2's", () => {
    expect(DEFAULT_SKILLS).toBe(`${UNITS}\n${HAIKU}\n${SKILL_SET}`)
    expect(SKILLS_IMPORTS.split("\n")).toEqual([
      'import { Effect, Schema } from "effect"',
      'import { Tool, Toolkit } from "effect/ai"',
      'import { defineSkill, skills } from "@xandreed/sdk"',
      'import { tools } from "./tools.ts"',
    ])
    expect(skillsDocumentOf(DEFAULT_SKILLS)).toBe(`${SKILLS_IMPORTS}\n\n${DEFAULT_SKILLS}\n`)
    expect(DEFAULT_SKILLS.endsWith("export const skillSet = skills(tools, units, haiku)")).toBe(true)
    // The units skill owns its tool: convert is in no toolkit but the skill's, and its handlers are a layer of their own.
    expect(UNITS).toContain("  tools: Toolkit.make(convert),\n")
    expect(UNITS).toContain("export const unitsLive = units.tools.toLayer({\n")
    expect(HAIKU).toContain("  tools: Toolkit.empty,\n")
    expect(DEFAULT_TOOLS).not.toContain("convert")
    // Neither skill is annotated: `skills` takes each with its own type.
    expect(DEFAULT_SKILLS).not.toMatch(/: Skill\b|Toolkit\.Any/)
    // The files the page shows beside them are lesson 2's own texts.
    const shown = Object.fromEntries(skillsLesson.files.map((file) => [file.id, file.defaultText]))
    expect([shown.tools, shown.memory, shown.skills, shown.agent]).toEqual([DEFAULT_TOOLS, DEFAULT_MEMORY, DEFAULT_SKILLS, DEFAULT_AGENT])
  })

  test("each experiment changes the lines it names, and no other", () => {
    expect(changed(DEFAULT_AGENT, Option.getOrThrow(alwaysOn(DEFAULT_AGENT)))).toEqual({
      gone: [...SYSTEM_LINES.trimEnd().split("\n"), ...OFFERED.trimEnd().split("\n")],
      come: [...SYSTEM_WITH_INSTRUCTIONS.trimEnd().split("\n"), ...WHOLE_TOOLKIT.trimEnd().split("\n")],
    })
    expect(Option.getOrThrow(alwaysOn(DEFAULT_AGENT))).not.toContain("skillSet.catalogue")
    expect(changed(DEFAULT_AGENT, Option.getOrThrow(noCatalogue(DEFAULT_AGENT)))).toEqual({ gone: SYSTEM_LINES.trimEnd().split("\n"), come: SYSTEM_ALONE.trimEnd().split("\n") })
    expect(changed(DEFAULT_AGENT, Option.getOrThrow(noHandlers(DEFAULT_AGENT)))).toEqual({ gone: [UNITS_LINE.trimEnd()], come: [NO_UNITS_LINE.trimEnd()] })
    expect(Option.getOrThrow(noHandlers(DEFAULT_AGENT))).not.toContain("unitsLive")
    // A line the learner rewrote is left alone, and always-on changes both of its lines or neither.
    expect(alwaysOn(DEFAULT_AGENT.replace("skillSet.offered(yield* session.journal)", "skillSet.offered(journal)"))).toEqual(Option.none())
    expect(alwaysOn(DEFAULT_AGENT.replace("${skillSet.catalogue}", "${skillSet.catalogue}!"))).toEqual(Option.none())
    expect(noCatalogue(DEFAULT_AGENT.replace("${skillSet.catalogue}", "${skillSet.catalogue}!"))).toEqual(Option.none())
    expect(noHandlers(DEFAULT_AGENT.replace("Effect.provide(unitsLive)", "Effect.provide(handlers)"))).toEqual(Option.none())
  })

  test("a skill is loaded by a call: the model reads the catalogue, the load's result is the instructions, and convert is offered from the next step", async () => {
    const script = [calls(load("units")), calls(convert), says("3.1 mi.")]
    const result = await Effect.runPromise(runMain(write("load"), ["How far is 5 km in miles?"], script))
    expect(result.shown.errors).toEqual([])
    expect(result.shown.replies).toEqual(["3.1 mi."])
    // What each step offered: lesson 2's tools and loadSkill, then the skill's tool too.
    expect(await offeredOnThePage(["How far is 5 km in miles?"], script)).toEqual([BASE, [...BASE, "convert"], [...BASE, "convert"]])
    // What the model was sent: the system text with the catalogue, the same in the three calls.
    expect(result.calls.map((prompt) => prompt[0])).toEqual([{ role: "system", text: SYSTEM }, { role: "system", text: SYSTEM }, { role: "system", text: SYSTEM }])
    expect(result.calls[0]?.slice(1)).toEqual([{ role: "user", text: "How far is 5 km in miles?" }])
    // The instructions reach the model as the tool's answer, among the messages.
    expect(result.calls[1]?.slice(1)).toEqual([
      { role: "user", text: "How far is 5 km in miles?" },
      { role: "assistant", text: 'loadSkill({"skill":"units"})' },
      loadedResult("units", UNITS_INSTRUCTIONS),
    ])
    expect(result.calls[2]?.slice(1)).toEqual([
      ...(result.calls[1]?.slice(1) ?? []),
      { role: "assistant", text: 'convert({"value":5,"from":"km","to":"mi"})' },
      { role: "tool", text: `→ ${JSON.stringify(5 / 1.609344)}` },
    ])
    expect(result.shown.status).toEqual(["turn 1", "step 1: loadSkill", "step 2: convert"])
  })

  test("a skill stays loaded in the turns after: the next turn offers its tool from its first step, and the instructions are still sent", async () => {
    const script = [calls(load("units")), says("Loaded."), calls(convert), says("3.1 mi.")]
    const result = await Effect.runPromise(runMain(write("stays"), ["Load units.", "How far is 5 km in miles?"], script))
    expect(result.shown.replies).toEqual(["Loaded.", "3.1 mi."])
    expect(await offeredOnThePage(["Load units.", "How far is 5 km in miles?"], script)).toEqual([BASE, [...BASE, "convert"], [...BASE, "convert"], [...BASE, "convert"]])
    expect(result.calls[2]?.slice(1)).toEqual([
      { role: "user", text: "Load units." },
      { role: "assistant", text: 'loadSkill({"skill":"units"})' },
      loadedResult("units", UNITS_INSTRUCTIONS),
      { role: "assistant", text: "Loaded." },
      { role: "user", text: "How far is 5 km in miles?" },
    ])
  })

  test("a call of convert before its skill is loaded fails as a call of an unknown tool, also in the step that loads the skill", async () => {
    const script = [calls(convert), calls(load("units"), convert), calls(convert), says("3.1 mi.")]
    const result = await Effect.runPromise(runMain(write("unloaded"), ["How far is 5 km in miles?"], script))
    expect(result.shown.errors).toEqual([])
    expect(await offeredOnThePage(["How far is 5 km in miles?"], script)).toEqual([BASE, BASE, [...BASE, "convert"], [...BASE, "convert"]])
    // The failed result, word for word: the toolkit that was offered holds no such tool, and names those it holds.
    expect(result.calls[1]?.slice(1)).toEqual([
      { role: "user", text: "How far is 5 km in miles?" },
      { role: "assistant", text: 'convert({"value":5,"from":"km","to":"mi"})' },
      { role: "tool", text: `→ failed: ${JSON.stringify(NOT_FOUND)}` },
    ])
    // Asked for in the same step as its load: what is offered was read before the step, so it is not there yet.
    expect(result.calls[2]?.slice(4)).toEqual([
      { role: "assistant", text: 'loadSkill({"skill":"units"})convert({"value":5,"from":"km","to":"mi"})' },
      loadedResult("units", UNITS_INSTRUCTIONS),
      { role: "tool", text: `→ failed: ${JSON.stringify(NOT_FOUND)}` },
    ])
    // From the step after the load the same call runs.
    expect(result.calls[3]?.at(-1)).toEqual({ role: "tool", text: `→ ${JSON.stringify(5 / 1.609344)}` })
  })

  test("a skill that is instructions alone loads the same way and adds no tool; a name no skill has fails with the names there are", async () => {
    const script = [calls(load("haikus")), calls(load("haiku")), says("Rain on the window.")]
    const result = await Effect.runPromise(runMain(write("haiku"), ["Write a haiku about rain."], script))
    expect(result.shown.replies).toEqual(["Rain on the window."])
    expect(await offeredOnThePage(["Write a haiku about rain."], script)).toEqual([BASE, BASE, BASE])
    expect(result.calls[2]?.slice(1)).toEqual([
      { role: "user", text: "Write a haiku about rain." },
      { role: "assistant", text: 'loadSkill({"skill":"haikus"})' },
      { role: "tool", text: '→ failed: "No skill is named \\"haikus\\". The skills are: units, haiku."' },
      { role: "assistant", text: 'loadSkill({"skill":"haiku"})' },
      loadedResult("haiku", HAIKU_INSTRUCTIONS),
    ])
  })

  test("with everything always on (an experiment), every tool is offered from the first step and both skills' instructions are in the system text", async () => {
    const script = [calls(convert), says("3.1 mi.")]
    const always = Option.getOrThrow(alwaysOn(DEFAULT_AGENT))
    const result = await Effect.runPromise(runMain(write("always", always), ["How far is 5 km in miles?"], script))
    expect(result.shown.replies).toEqual(["3.1 mi."])
    expect(await offeredOnThePage(["How far is 5 km in miles?"], script, always)).toEqual([[...BASE, "convert"], [...BASE, "convert"]])
    expect(result.calls[0]).toEqual([
      { role: "system", text: `${OPENING_TEXT}\n\n${UNITS_INSTRUCTIONS}\n\n${HAIKU_INSTRUCTIONS}` },
      { role: "user", text: "How far is 5 km in miles?" },
    ])
    expect(result.calls[1]?.at(-1)).toEqual({ role: "tool", text: `→ ${JSON.stringify(5 / 1.609344)}` })
  })

  test("without the catalogue (an experiment), the system text names no skill, and a load still works", async () => {
    const script = [calls(load("units")), says("Loaded.")]
    const unlisted = Option.getOrThrow(noCatalogue(DEFAULT_AGENT))
    const result = await Effect.runPromise(runMain(write("no-catalogue", unlisted), ["Load units."], script))
    expect(result.calls.map((prompt) => prompt[0])).toEqual([{ role: "system", text: OPENING_TEXT }, { role: "system", text: OPENING_TEXT }])
    expect(await offeredOnThePage(["Load units."], script, unlisted)).toEqual([BASE, [...BASE, "convert"]])
  })

  test("each line this lesson adds to the shown files fits 100 columns", () => {
    const added = [DEFAULT_SKILLS, OPENING, SYSTEM_LINES, OFFERED, UNITS_LINE, LOADER_LINE, SYSTEM_WITH_INSTRUCTIONS, WHOLE_TOOLKIT, SYSTEM_ALONE, NO_UNITS_LINE]
    expect(added.flatMap((text) => text.split("\n")).filter((line) => line.length > 100)).toEqual([])
  })

  test("type-level: the program that leaves out a skill's handlers, as the no-handlers experiment leaves it, does not compile, and the compiler names the handler; nor does one without loadSkill's", () => {
    // `run` says its program needs nothing more. The toolkit a step offers is typed as every tool it could hold, so
    // a call of it needs convert's handler whether the skill is loaded or not: take main's line away, and tsc
    // refuses the program where its type is written out. The same holds for loadSkill's handler.
    write("missing/units", Option.getOrThrow(noHandlers(DEFAULT_AGENT)))
    const withoutLoader = DEFAULT_AGENT.replace(LOADER_LINE, "")
    expect(withoutLoader).not.toContain("skillSet.handlers")
    write("missing/loader", withoutLoader)
    const missing = new URL("./missing/tsconfig.json", dir)
    writeFileSync(missing, JSON.stringify({ extends: "../../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(missing)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    const said = `${checked.stdout.toString()}${checked.stderr.toString()}`
    rmSync(new URL("./missing/", dir), { recursive: true, force: true })
    expect(checked.exitCode).not.toBe(0)
    const errors = said.split("\n").filter((line) => line.includes("error TS"))
    // One error a program, each in its agent.ts: nothing else of the five files is wrong.
    expect(errors).toHaveLength(2)
    expect(errors.find((line) => line.includes("missing/units/agent.ts"))).toContain("Handler<\"convert\">")
    expect(errors.find((line) => line.includes("missing/loader/agent.ts"))).toContain("Handler<\"loadSkill\">")
    expect(said).toContain("Type 'Handler<\"convert\">' is not assignable to type 'never'")
    expect(said).toContain("Type 'Handler<\"loadSkill\">' is not assignable to type 'never'")
  }, 120_000)

  test("type-checks as TypeScript, all five files, as shown and as each experiment that provides every handler leaves them", () => {
    write("typed")
    write("typed-always", Option.getOrThrow(alwaysOn(DEFAULT_AGENT)))
    write("typed-no-catalogue", Option.getOrThrow(noCatalogue(DEFAULT_AGENT)))
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
