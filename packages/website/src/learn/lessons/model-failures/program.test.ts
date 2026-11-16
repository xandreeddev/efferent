// Lesson 14's five files, compiled as written, type-checked as shown and as
// each experiment leaves them, and run on the kernel with a scripted model
// for the model picked and a scripted spare: a call tried again, a call
// handed to the spare, and an answer cut after a word. agent.ts is checked
// against the base program it derives from, and the programs whose model
// call needs a model nobody provides are checked not to compile.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Deferred, Effect, Fiber, Option, Ref } from "effect"
import type { Layer } from "effect"
import type { LanguageModel } from "effect/ai"
import { scriptedModel } from "@xandreed/sdk/kernel"
import type { ModelScript } from "@xandreed/sdk/kernel"
import { BASE_AGENT, IMPORTS as BASE_IMPORTS } from "../base/agent.source.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, IMPORTS, moduleOf, MODEL_SERVICE, NO_MODEL, PLAN, PLANNED_CALL, REPLACED, REPLACED_IMPORTS, SPARE_COMMENT } from "./agent.source.ts"
import { CUT, cut, DOWN, down, FAILS_ONCE, failsOnce, NO_WHILE, noWhile, PLAN_ALONE_LINE, planAlone, PLANNED_LINE, THREE_DOWN, threeDown, WHILE } from "./config-edit.ts"
import { DEFAULT_FAILURES, failuresDocumentOf, FAILURES_INTRO } from "./failures.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const root = fileURLToPath(new URL("../../../../", import.meta.url))

interface Shown {
  readonly pieces: ReadonlyArray<string>
  readonly replies: ReadonlyArray<string>
  readonly errors: ReadonlyArray<string>
}

/**
 * The five files as a test compiles them, in a folder of their own; `fails.ts` beside them holds the list to the
 * kernel's scripted `Fails`, without its `_tag`: what failures.ts declares is no wider than what the kernel's
 * scripted model takes.
 */
const write = (name: string, agent: string = DEFAULT_AGENT, failures: string = DEFAULT_FAILURES) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(agent))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(DEFAULT_TOOLS))
  writeFileSync(new URL("./failures.ts", at), failuresDocumentOf(failures))
  writeFileSync(new URL("./fails.ts", at), `import type { ScriptedAnswer } from "@xandreed/sdk/kernel"
import { failures } from "./failures.ts"

type Fails = Omit<Extract<ScriptedAnswer, { readonly _tag: "Fails" }>, "_tag">
export const script: ReadonlyArray<Fails> = failures
`)
  return new URL("./agent.ts", at)
}

/** tsc over the folders given, with the learn track's settings: what it said, and how it ended. */
const compiled = (folder: string) => {
  const config = new URL(`./${folder}/tsconfig.json`, dir)
  writeFileSync(config, JSON.stringify({ extends: `${"../".repeat(folder.split("/").length + 5)}tsconfig.learn.json`, include: ["./**/*.ts"], exclude: [] }))
  const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(config)], { cwd: root })
  return { said: `${checked.stdout.toString()}${checked.stderr.toString()}`, exitCode: checked.exitCode }
}

type Pane = { readonly onSend: (send: (text: string) => void) => void; readonly appendToAnswer: (piece: string) => void; readonly finishAnswer: (text: string) => void; readonly showError: (error: unknown) => void; readonly showStatus: (text: string) => void }
type Run = (pane: Pane, model: Layer.Layer<LanguageModel.LanguageModel>, spare: Layer.Layer<LanguageModel.LanguageModel>) => Effect.Effect<void, unknown>

/**
 * Run `main` from the module at `file`, the model picked and the spare each a scripted model, and send `message`:
 * what was shown once it was answered or failed, and every prompt each model received.
 */
const runMain = (file: URL, message: string, picked: ModelScript, spare: ModelScript) => Effect.gen(function* () {
  const { run }: { readonly run: Run } = yield* Effect.promise(() => import(file.href))
  const first = yield* scriptedModel(picked)
  const second = yield* scriptedModel(spare)
  const shown = yield* Ref.make<Shown>({ pieces: [], replies: [], errors: [] })
  const done = yield* Deferred.make<void>()
  const sent = yield* Deferred.make<(text: string) => void>()
  const note = (key: keyof Shown, text: string) => Effect.runSync(Ref.update(shown, (all) => ({ ...all, [key]: [...all[key], text] })))
  const pane: Pane = {
    onSend: (given) => { Effect.runSync(Deferred.succeed(sent, given)) },
    appendToAnswer: (piece) => note("pieces", piece),
    finishAnswer: (text) => { note("replies", text); Effect.runSync(Deferred.succeed(done, undefined)) },
    showError: (error) => { note("errors", String(error)); Effect.runSync(Deferred.succeed(done, undefined)) },
    showStatus: () => {},
  }
  const program = yield* Effect.forkChild(run(pane, first.model, second.model))
  const send = yield* Deferred.await(sent)
  send(message)
  yield* Deferred.await(done)
  yield* Fiber.interrupt(program)
  return { shown: yield* Ref.get(shown), picked: yield* first.calls, spare: yield* second.calls }
}).pipe(Effect.scoped, Effect.timeout("20 seconds"))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const SYSTEM = { role: "system", text: "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence." }
const HI = [SYSTEM, { role: "user", text: "Hi." }]

/** The lines in `after` that are not in `before`, and the other way round. */
const changed = (before: string, after: string) => ({
  gone: before.split("\n").filter((line) => !after.split("\n").includes(line)),
  come: after.split("\n").filter((line) => !before.split("\n").includes(line)),
})

describe("lesson 14's displayed program", () => {
  test("the base program still holds each piece this lesson replaces, once, and agent.ts differs from it by those pieces alone", () => {
    for (const [from] of REPLACED) expect({ from, held: BASE_AGENT.split(from).length - 1 }).toEqual({ from, held: 1 })
    for (const [from] of REPLACED_IMPORTS) expect({ from, held: BASE_IMPORTS.split(from).length - 1 }).toEqual({ from, held: 1 })
    const { gone, come } = changed(BASE_AGENT, DEFAULT_AGENT)
    // The loop no longer takes the model as a service; the call is the plan's; main's comment names the spare and
    // its last line provides no model.
    expect(gone).toEqual([
      MODEL_SERVICE.trimEnd(),
      "        // Ask the model, with the tools offered but not run: this loop runs the calls. A call the",
      "        // model got wrong comes through as it is (\"deferred\"), so it can be answered as a failure.",
      "          model.streamText({",
      "          }),",
      "// `pane` and `model` come from the page: the chat on the right, and the model you picked.",
      "  Effect.provide(model), // the model you picked",
    ])
    expect(come).toEqual([
      ...PLAN.trimEnd().split("\n").filter((line) => line !== "" && !BASE_AGENT.split("\n").includes(line)),
      ...PLANNED_CALL.split("\n").filter((line) => line !== "" && !BASE_AGENT.split("\n").includes(line)),
      ...SPARE_COMMENT.trimEnd().split("\n"),
      NO_MODEL.trimEnd(),
    ])
    expect(DEFAULT_AGENT).toContain("const answer = yield* modelAnswer(\n          LanguageModel.streamText({")
    expect(DEFAULT_AGENT).not.toContain("yield* LanguageModel.LanguageModel")
    expect(DEFAULT_AGENT).not.toContain("Effect.provide(model)")
    // The plan sits above the turn that uses it.
    expect(DEFAULT_AGENT.indexOf("const plan = ExecutionPlan.make(")).toBeLessThan(DEFAULT_AGENT.indexOf("const turn = (message) =>"))
    // The imports gain Effect's plan and schedule, and the kernel's planned and retryable.
    expect(changed(BASE_IMPORTS, IMPORTS)).toEqual({
      gone: ['import { Effect, Stream } from "effect"', 'import { callTool, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk/kernel"'],
      come: ['import { Effect, ExecutionPlan, Schedule, Stream } from "effect"', 'import { callTool, inProcessJournal, Memory, modelAnswer, planned, retryable, sessions } from "@xandreed/sdk/kernel"'],
    })
    // `spare` is named by no import: it is the page's, as `pane` and `model` are, and main's comment says so.
    expect(IMPORTS).not.toContain("spare")
    expect(SPARE_COMMENT).toContain("`pane`, `model` and `spare` come from the page")
  })

  test("the plan is the one the lesson describes: the model picked, three tries a second apart while a failure is worth another try, then the spare once", () => {
    expect(PLAN).toContain(`const plan = ExecutionPlan.make(
  {
    // The model you picked. The page makes it fail as failures.ts says.
    provide: model,
    // Up to three tries on this step, the first one included.
    attempts: 3,
    // How long to wait before the next try.
    schedule: Schedule.spaced("1 second"),
`)
    expect(PLAN).toContain(`    while: retryable,
  },
  // The spare: a second Echo, given by the page, tried once.
  { provide: spare },
)`)
    expect(PLANNED_CALL).toContain("}).pipe(planned(plan)),")
  })

  test("failures.ts declares its entry's type in the read-only part, and the list the learner edits starts with one failure worth another try", () => {
    expect(FAILURES_INTRO.endsWith("export const failures: ReadonlyArray<Failure> = ")).toBe(true)
    expect(FAILURES_INTRO).toContain("type Failure = {\n")
    expect(DEFAULT_FAILURES).toBe("[{ retryable: true }]")
    expect(failuresDocumentOf(DEFAULT_FAILURES)).toContain("export const failures: ReadonlyArray<Failure> = [{ retryable: true }]\n")
    // The comment says plainly that the failures are the page's, and that the model is not called.
    expect(FAILURES_INTRO).toContain("The page makes these failures, so the lesson can show them on any model: a call made to fail\n// here never reaches the model, and the pieces it shows are the page's words.")
  })

  test("each experiment changes the lines it names, and no other", () => {
    expect(Option.getOrThrow(failsOnce("[]"))).toBe(FAILS_ONCE)
    expect(FAILS_ONCE).toBe(DEFAULT_FAILURES)
    expect(Option.getOrThrow(down(DEFAULT_FAILURES))).toBe(DOWN)
    expect(Option.getOrThrow(cut(DEFAULT_FAILURES))).toBe(CUT)
    expect(Option.getOrThrow(threeDown(DEFAULT_FAILURES))).toBe(THREE_DOWN)
    expect(changed(DEFAULT_AGENT, Option.getOrThrow(planAlone(DEFAULT_AGENT)))).toEqual({ gone: [PLANNED_LINE.trimEnd()], come: [PLAN_ALONE_LINE.trimEnd()] })
    expect(changed(DEFAULT_AGENT, Option.getOrThrow(noWhile(DEFAULT_AGENT)))).toEqual({ gone: WHILE.trimEnd().split("\n"), come: [NO_WHILE.trimEnd()] })
    // A line the learner rewrote is left alone.
    expect(planAlone(DEFAULT_AGENT.replace("planned(plan)", "planned(myPlan)"))).toEqual(Option.none())
    expect(noWhile(DEFAULT_AGENT.replace("while: retryable", "while: () => true"))).toEqual(Option.none())
  })

  test("each line this lesson adds to the shown files fits 100 columns", () => {
    const added = [PLAN, PLANNED_CALL, SPARE_COMMENT, NO_MODEL, FAILURES_INTRO, NO_WHILE, PLAN_ALONE_LINE]
    expect(added.flatMap((text) => text.split("\n")).filter((line) => line.length > 100)).toEqual([])
  })

  test("type-checks as TypeScript, all five files, as shown and as each experiment leaves them, with failures.ts's list no wider than the scripted model's Fails", () => {
    write("typed/shown")
    write("typed/fails-once", DEFAULT_AGENT, FAILS_ONCE)
    write("typed/down", DEFAULT_AGENT, DOWN)
    write("typed/cut", DEFAULT_AGENT, CUT)
    // plan-alone leaves `planned` imported and unused, and no-while `retryable`: the imports are read-only text.
    write("typed/plan-alone", Option.getOrThrow(planAlone(DEFAULT_AGENT)), CUT)
    write("typed/no-while", Option.getOrThrow(noWhile(DEFAULT_AGENT)), THREE_DOWN)
    const { said, exitCode } = compiled("typed")
    expect(said).toBe("")
    expect(exitCode).toBe(0)
  }, 120_000)

  test("type-level: an entry of failures.ts that is not a Failure does not compile", () => {
    write("wrong-entry/one", DEFAULT_AGENT, '[{ retryable: "yes" }]')
    const { said, exitCode } = compiled("wrong-entry")
    expect(exitCode).not.toBe(0)
    expect(said).toContain("failures.ts")
    expect(said).toContain("Type 'string' is not assignable to type 'boolean'")
  }, 120_000)

  test("type-level: a step with no provide, a plan whose steps provide no model, and a call not planned while main provides none, do not compile, and the compiler says what is missing", () => {
    // The steps without \`provide\`: Effect's plan refuses a step that provides nothing.
    write("missing/no-provide", DEFAULT_AGENT.replace("    provide: model,\n", "").replace("  { provide: spare },\n", "  { attempts: 1 },\n"))
    // A step that provides a part that is no model: the call still needs one, and nothing gives it.
    write("missing/no-model", DEFAULT_AGENT.replace("    provide: model,\n", "    provide: toolsLive,\n").replace("  { provide: spare },\n", "  { provide: toolsLive },\n"))
    // The call without \`planned(plan)\`: main provides no model either.
    write("missing/not-planned", DEFAULT_AGENT.replace(PLANNED_LINE, "          }),\n"))
    const { said, exitCode } = compiled("missing")
    expect(exitCode).not.toBe(0)
    /** The first line of each error tsc gave for a folder's agent.ts, and the line after it. */
    const errorsOf = (folder: string) => {
      const lines = said.split("\n")
      return lines.flatMap((line, at) => (line.includes(`missing/${folder}/agent.ts`) && line.includes("error TS") ? [`${line.replace(/^.*error /, "")} ${lines[at + 1]?.trim() ?? ""}`] : []))
    }
    expect(errorsOf("no-provide").some((error) => error.includes("Property 'provide' is missing"))).toBe(true)
    expect(errorsOf("no-model").some((error) => error.includes("Type 'LanguageModel' is not assignable to type 'never'"))).toBe(true)
    expect(errorsOf("not-planned")).toHaveLength(1)
    expect(errorsOf("not-planned")[0]).toContain("Type 'LanguageModel' is not assignable to type 'never'")
    // Nothing but the three agent.ts files is wrong.
    expect(said.split("\n").filter((line) => line.includes("error TS") && !line.includes("/agent.ts"))).toEqual([])
  }, 120_000)
})

describe("lesson 14's program on the kernel, the model picked and the spare each scripted", () => {
  test("a failure worth another try: the model picked is asked again with the same prompt, and its answer is the turn's; the spare is not asked", async () => {
    const ran = await Effect.runPromise(runMain(write("retry"), "Hi.", [{ _tag: "Fails", retryable: true }, { _tag: "Answers", pieces: ["Hello."] }], [{ _tag: "Answers", pieces: ["Spare."] }]))
    expect(ran.shown).toEqual({ pieces: ["Hello."], replies: ["Hello."], errors: [] })
    expect(ran.picked).toEqual([HI, HI])
    expect(ran.spare).toEqual([])
  })

  test("a failure not worth another try: the call goes to the spare at once, with the same prompt, and the spare's answer is the turn's", async () => {
    const ran = await Effect.runPromise(runMain(write("fallback"), "Hi.", [{ _tag: "Fails" }, { _tag: "Answers", pieces: ["Hello."] }], [{ _tag: "Answers", pieces: ["From the spare."] }]))
    expect(ran.shown).toEqual({ pieces: ["From the spare."], replies: ["From the spare."], errors: [] })
    expect(ran.picked).toEqual([HI])
    expect(ran.spare).toEqual([HI])
  })

  test("a failure after a word: the word stays shown, the turn fails with the cut answer, and neither model is asked again", async () => {
    const ran = await Effect.runPromise(runMain(write("cut"), "Hi.", [{ _tag: "Fails", retryable: true, pieces: ["Half "] }, { _tag: "Answers", pieces: ["Hello."] }], [{ _tag: "Answers", pieces: ["Spare."] }]))
    expect(ran.shown.pieces).toEqual(["Half "])
    expect(ran.shown.replies).toEqual([])
    expect(ran.shown.errors).toEqual(["AnswerCut: ScriptedModel.streamText: Internal provider error: the scripted model was told to fail, and to be tried again"])
    expect(ran.picked).toEqual([HI])
    expect(ran.spare).toEqual([])
  })
})
