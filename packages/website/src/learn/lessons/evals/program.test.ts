// Lesson 13's files, compiled as written, type-checked, and run on the
// kernel: agent.ts is lesson 12's as it is; runnable.ts's lines that run a
// trial are lesson 12's `turnsAfter`, by named pieces, and what the page runs
// of it is the shown text with its types taken out, by named pieces; evals.ts
// compiles with its dataset, graders and gates held to the eval package's
// types, as shown and as each experiment leaves it; and the suite, run with
// `runEvaluation` on scripted candidates, passes a script that answers as
// Echo does on every task and fails one that answers nothing right, with the
// gate's verdict, the intervals and the comparison's regressions.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Option, Schema } from "effect"
import type { LanguageModel } from "effect/ai"
import { scriptedModel } from "@xandreed/sdk/kernel"
import type { ModelScript } from "@xandreed/sdk/kernel"
import { EvaluationRun, Trial } from "@xandreed/evals"
import { wilsonInterval } from "@xandreed/evals/stats"
import { formatRegion } from "../../format.ts"
import { applyExperiment } from "../../lesson.ts"
import { CHAT } from "../test-your-agent/chat.source.ts"
import { DEFAULT_AGENT as LESSON_12_AGENT } from "../test-your-agent/agent.source.ts"
import { TURNS_AFTER, TYPED as CHECKS_TYPED } from "../test-your-agent/checks.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, moduleOf } from "./agent.source.ts"
import { ANSWER_CHECK, CASES_END, DEFAULT_EVALS, EVALS_IMPORTS, evalsBodyOf, evalsDocumentOf, evalsModuleOf, GATE, REPETITIONS, TYPED } from "./evals.source.ts"
import { LENIENT_CHECK, MISSED_TASK, STRICT_GATE } from "./config-edit.ts"
import { evalsLesson } from "./lesson.ts"
import { PAGE_GIVES, REPLACED, RUNNABLE, RUNNABLE_IMPORTS, runnableBodyOf, runnableModuleOf, TURNS_AFTER_TYPED, TYPES } from "./runnable.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

/** The files a learner edits, as the lesson starts or as an experiment leaves them. */
interface Files {
  readonly evals?: string
  readonly tools?: string
}

const write = (name: string, files: Files = {}) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(DEFAULT_AGENT))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./evals.ts", at), evalsModuleOf(files.evals ?? DEFAULT_EVALS))
  writeFileSync(new URL("./runnable.ts", at), runnableModuleOf(RUNNABLE))
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(files.tools ?? DEFAULT_TOOLS))
  return at
}

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const STARTERS: Record<string, string> = Object.fromEntries(evalsLesson.files.map((file) => [file.id, file.defaultText]))

/** The files as an experiment leaves them: every file it edits, all of them or none. */
const applied = (id: string): Files => {
  const experiment = Option.fromNullishOr(evalsLesson.experiments[id])
  return Object.fromEntries(Option.getOrThrow(Option.flatMap(experiment, (one) => applyExperiment(one, (file) => STARTERS[file] ?? ""))))
}

/** The lines of `after` that `before` has not, and the lines of `before` that `after` has not. */
const changed = (before: string, after: string) => ({
  gone: before.split("\n").filter((line) => !after.split("\n").includes(line)),
  come: after.split("\n").filter((line) => !before.split("\n").includes(line)),
})

/** How many times `piece` is in `text`. */
const times = (text: string, piece: string): number => text.split(piece).length - 1

type Run = (models: Readonly<Record<string, Layer.Layer<LanguageModel.LanguageModel>>>, hear: (trial: Trial) => void) => Effect.Effect<unknown, unknown>

const calls = (name: string, input: Record<string, string | number>): ModelScript[number] => ({ _tag: "Calls", pieces: [], calls: [{ name, params: input }] })
const says = (text: string): ModelScript[number] => ({ _tag: "Answers", pieces: [text] })
/** Five times over: a scripted model answers its calls in order, and a candidate's trials run one after the other. */
const fives = (...entries: ReadonlyArray<ModelScript[number]>): ModelScript => Array.from({ length: 5 }).flatMap(() => entries)

/** A script that answers each of the four tasks as Echo does, five times each, in the order the trials run. */
const ECHO_LIKE: ModelScript = [
  ...fives(calls("calculator", { a: 2, op: "+", b: 3 }), says("The tool answered: calculator says 5.")),
  ...fives(calls("calculator", { a: 12, op: "*", b: 3 }), says("The tool answered: calculator says 36.")),
  ...fives(says("The meeting is on Tuesday.")),
  ...fives(says("The keys are under the mat.")),
]

/** What the run gives: each candidate's run, and the comparison. */
const Outcome = Schema.Struct({
  runs: Schema.Array(EvaluationRun),
  comparison: Schema.Array(Schema.Struct({ candidate: Schema.String, attempts: Schema.Number, successes: Schema.Number, infrastructure: Schema.Number, regressions: Schema.Array(Schema.String) })),
})

/** Run the suite of the files written at `at`, each candidate a scripted model: what the run gave, and every trial written. */
const ran = async (at: URL, scripts: Readonly<Record<string, ModelScript>>) => {
  const { run }: { readonly run: Run } = await import(new URL("./runnable.ts", at).href)
  const models = Object.fromEntries(await Promise.all(Object.entries(scripts).map(async ([name, script]) => [name, (await Effect.runPromise(scriptedModel(script))).model] as const)))
  const heard: Array<Trial> = []
  const outcome = await Effect.runPromise(Effect.flatMap(run(models, (trial) => { heard.push(trial) }), Schema.decodeUnknownEffect(Schema.toType(Outcome))))
  const passedOf = (trial: Trial) => trial.grades.filter((grade) => grade.grader === "answer").every((grade) => grade.metrics.some((metric) => metric.value === true))
  const byCandidate = (name: string) => outcome.runs.flatMap((one) => one.trials).filter((trial) => trial.candidate.id === name)
  return {
    outcome,
    heard,
    passes: (name: string) => byCandidate(name).filter(passedOf).length,
    gates: outcome.runs.flatMap((one) => one.gates).map((gate) => [gate.candidate, gate.grader, gate.passed, Option.getOrNull(gate.value), gate.reason]),
    comparison: outcome.comparison.map((one) => [one.candidate, one.successes, one.attempts, [...new Set(one.regressions)]]),
    infrastructure: outcome.comparison.map((one) => [one.candidate, one.infrastructure]),
    statuses: (name: string) => [...new Set(byCandidate(name).map((trial) => trial.status))],
    reasons: (name: string, task: string) => byCandidate(name).filter((trial) => trial.task.id === task && trial.sample === 1).flatMap((trial) => trial.grades.map((grade) => `${grade.grader}: ${grade.reason}`)),
  }
}

describe("lesson 13's displayed program", () => {
  test("agent.ts is lesson 12's, as it is: nothing is replaced", () => {
    expect(DEFAULT_AGENT).toBe(LESSON_12_AGENT)
    expect(STARTERS.evals).toBe(DEFAULT_EVALS)
    expect(STARTERS.tools).toBe(DEFAULT_TOOLS)
    // The read-only files the page shows are these texts.
    const shown = Object.fromEntries(evalsLesson.files.filter((file) => file.readOnly).map((file) => [file.id, file.documentOf("")]))
    expect(Object.keys(shown)).toEqual(["runnable", "agent", "chat", "memory"])
    expect(shown.runnable).toBe(RUNNABLE)
    expect(shown.chat).toBe(CHAT)
  })

  test("runnable.ts's turnsAfter is lesson 12's, by named pieces: each piece is in lesson 12's text once, and nothing else differs", () => {
    for (const [from] of REPLACED) expect({ from, held: times(TURNS_AFTER, from) }).toEqual({ from, held: 1 })
    for (const [from] of TURNS_AFTER_TYPED) expect({ from, held: times(TURNS_AFTER, from) }).toEqual({ from, held: 1 })
    // Lesson 12's typed lines of turnsAfter, but its signature, which is laid out here as Prettier lays it out.
    expect(TURNS_AFTER_TYPED.slice(1)).toEqual(CHECKS_TYPED.slice(1, 4))
    // As the page runs it, turnsAfter is lesson 12's text with the comments of a check made a trial's, and the model's line.
    const body = runnableBodyOf(RUNNABLE)
    const asRun = body.slice(body.indexOf("// Run the program for one trial"), body.indexOf("// What a trial keeps of its turns"))
    expect(changed(TURNS_AFTER, asRun.trimEnd())).toEqual({
      gone: [
        "// Run the program for a check. It is the program main runs, over a stack of the check's own: the",
        "// same modules, the model the check gives, and a chat that is a list. Each message is sent once",
        "// the one before it is answered, so each is a turn of its own. What comes back is the journal the",
        "    // A pane with no screen: Send is a function the check calls, and an answer or a failure goes",
        "    // onto a queue the check waits on.",
        "        // The program never ends on its own. If it stopped, the check stops too, with the reason.",
        "      Effect.provide(inProcessJournal()), // a journal of the check's own, kept in the page",
        "      Effect.provide(model), // a model that follows a script, or the model you picked",
      ],
      come: [
        "// Run the program for one trial: lesson 12's lines. It is the program main runs, over a stack of",
        "// the trial's own: the same modules, the candidate's model, and a chat that is a list. Each",
        "// message is sent once the one before it is answered. What comes back is the journal the",
        "    // A pane with no screen: Send is a function the trial calls, and an answer or a failure goes",
        "    // onto a queue the trial waits on.",
        "        // The program never ends on its own. If it stopped, the trial stops too, with the reason.",
        "      Effect.provide(inProcessJournal()), // a journal of the trial's own, kept in the page",
        "      Effect.provide(model), // the candidate's model",
      ],
    })
  })

  test("runnable.ts as the page runs it is the shown text with its imports and its types taken out, and nothing else", () => {
    for (const [from] of TYPES) expect({ from, held: times(RUNNABLE, from) }).toEqual({ from, held: 1 })
    const body = runnableBodyOf(RUNNABLE)
    expect(changed(RUNNABLE, body)).toEqual({
      gone: [
        ...RUNNABLE_IMPORTS.trimEnd().split("\n"),
        "const turnsAfter = (",
        "  model: Layer.Layer<LanguageModel.LanguageModel>,",
        "  messages: ReadonlyArray<string>,",
        "): Effect.Effect<ReadonlyArray<TurnRead>, unknown> =>",
        "    const replies = yield* Queue.unbounded<string>()",
        "    let send: (text: string) => void = () => {}",
        "    const pane: ChatPane = {",
        "const evidenceOf = (turns: ReadonlyArray<TurnRead>): typeof Evidence.Type =>",
        "export const Graded = Schema.Struct({ turns: Evidence, reference: dataset.reference })",
        "export type Graded = typeof Graded.Type",
        'const Runnable = runnableExecutionPort<string, string, typeof Evidence.Type, null>("lesson-program")',
        'const Environment = evaluationEnvironmentPort<string, null>("lesson-program")',
        "const passed = (trial: Trial) =>",
        "export const rowOf = (trial: Trial): DecisionTrial => ({",
        "const app: EvaluationApp = {",
        "export const evaluation = Effect.forEach(",
      ],
      come: [
        "const turnsAfter = (model, messages) =>",
        "    const replies = yield* Queue.unbounded()",
        "    let send = () => {}",
        "    const pane = {",
        "const evidenceOf = (turns) =>",
        "const Graded = Schema.Struct({ turns: Evidence, reference: dataset.reference })",
        'const Runnable = runnableExecutionPort("lesson-program")',
        'const Environment = evaluationEnvironmentPort("lesson-program")',
        "const passed = (trial) =>",
        "const rowOf = (trial) => ({",
        "const app = {",
        "const evaluation = Effect.forEach(",
      ],
    })
    // What is left names no type: no annotation, no type argument, no import.
    expect(body).not.toMatch(/\bimport\b|: (?:string|number|Trial|unknown)\b|<string\b|TurnRead|ChatPane|EvaluationApp|\bDecisionTrial\b/)
    // The names the page gives and no import names are said in a comment, where the typed module takes them.
    expect(times(RUNNABLE, PAGE_GIVES)).toBe(1)
    expect(RUNNABLE.slice(RUNNABLE.indexOf(PAGE_GIVES))).toContain("models\n// and hear come from the page, as model does in agent.ts.")
    // No cast in the text a learner reads, and no comment line over 100 columns.
    expect(RUNNABLE).not.toMatch(/\bas (?:never|any|unknown|const)\b/)
    expect(RUNNABLE.split("\n").filter((line) => line.trimStart().startsWith("//") && line.length > 100)).toEqual([])
  })

  test("evals.ts: its imports, the lines that take a type in the module a test compiles, and the pieces its experiments change", async () => {
    expect(EVALS_IMPORTS).toBe('import { Effect, Option, Schema } from "effect"')
    expect(evalsDocumentOf(DEFAULT_EVALS)).toBe(`${EVALS_IMPORTS}\n\n${DEFAULT_EVALS}\n`)
    for (const [from] of TYPED) expect({ from, held: times(DEFAULT_EVALS, from) }).toEqual({ from, held: 1 })
    for (const piece of [ANSWER_CHECK, CASES_END, GATE, REPETITIONS]) expect({ piece, held: times(DEFAULT_EVALS, piece) }).toEqual({ piece, held: 1 })
    expect(DEFAULT_EVALS.endsWith(`${GATE}]`)).toBe(true)
    // Plain JavaScript as written: the page runs it so. No cast, and no type written out.
    expect(evalsBodyOf(DEFAULT_EVALS)).not.toMatch(/\bas (?:never|any|unknown|const)\b|: (?:string|number|unknown|ReadonlyArray)\b|<[A-Z]/)
    expect(await formatRegion(DEFAULT_EVALS, "")).toEqual({ ok: true, text: DEFAULT_EVALS })
  })

  test("each experiment changes the pieces it names, and no other; one applied twice, or over a text that lost its piece, changes nothing", async () => {
    const lenient = applied("lenient")
    expect(changed(DEFAULT_EVALS, lenient.evals ?? "")).toEqual({
      gone: ANSWER_CHECK.trimEnd().split("\n"),
      come: LENIENT_CHECK.trimEnd().split("\n"),
    })
    expect(changed(DEFAULT_TOOLS, lenient.tools ?? "")).toEqual({
      gone: ['      : Effect.succeed({ "+": a + b, "-": a - b, "*": a * b, "/": a / b }[op]),'],
      come: ['      : Effect.succeed({ "+": a - b, "-": a - b, "*": a * b, "/": a / b }[op]),'],
    })
    expect(changed(DEFAULT_EVALS, applied("once").evals ?? "")).toEqual({ gone: ["export const repetitions = 5"], come: ["export const repetitions = 1"] })
    expect(applied("strict-gate").evals).toBe(`${DEFAULT_EVALS.slice(0, -1)}${STRICT_GATE}]`)
    expect(applied("baseline-misses").evals).toBe(DEFAULT_EVALS.replace(CASES_END, `${MISSED_TASK}${CASES_END}`))
    // Applied twice, an experiment finds its piece gone or already there, and changes nothing; so over a text rewritten.
    for (const [id, experiment] of Object.entries(evalsLesson.experiments)) {
      const once = applied(id)
      expect({ id, again: experiment.apply(once.evals ?? "") }).toEqual({ id, again: Option.none() })
      expect({ id, rewritten: experiment.apply("const dataset = 1") }).toEqual({ id, rewritten: Option.none() })
      // Every text an experiment leaves is as Format leaves it, and no line of a comment is longer than 100 columns.
      const texts: ReadonlyArray<string> = [once.evals ?? "", ...(once.tools === undefined ? [] : [once.tools])]
      for (const text of texts) {
        expect({ id, formatted: await formatRegion(text, "") }).toEqual({ id, formatted: { ok: true, text } })
        expect(text.split("\n").filter((line) => line.trimStart().startsWith("//") && line.length > 100)).toEqual([])
      }
    }
  })

  test("the suite on scripted candidates: a script that answers as Echo does passes every task, and one that answers nothing right fails every one, with its gate and its regressions", async () => {
    const at = write("run")
    const run = await ran(at, { echo: ECHO_LIKE, broken: [says("I cannot say.")] })
    // Four tasks, five times each, for two candidates: forty trials, each written as it starts, as it ends, and after each of its two grades.
    expect(run.outcome.runs.map((one): [string, number] => [one.id, one.trials.length])).toEqual([["run-echo", 20], ["run-broken", 20]])
    expect(run.heard).toHaveLength(160)
    expect([run.passes("echo"), run.passes("broken")]).toEqual([20, 0])
    expect(run.gates).toEqual([["echo", "answer@1", true, 1, "Passed"], ["broken", "answer@1", false, 0, "Outside threshold"]])
    expect(run.comparison).toEqual([["echo", 20, 20, []], ["broken", 0, 20, ["sum", "product", "meeting", "keys"]]])
    expect(run.reasons("echo", "sum")).toEqual(['answer: the answer holds "5"', 'tool: it called calculator({"a":2,"op":"+","b":3})'])
    expect(run.reasons("broken", "sum")).toEqual(['answer: the answer does not hold "5"', 'tool: it called no tool, not calculator({"a":2,"op":"+","b":3})'])
    expect(run.reasons("broken", "meeting")).toEqual(['answer: the answer does not hold "Tuesday"', "tool: it called no tool"])
    // Five of five, and none of five, leave these intervals: the eval package's statistics.
    expect([wilsonInterval(5, 5), wilsonInterval(0, 5)].map(({ low, high }) => [Number(low.toFixed(2)), high === 1 ? 1 : Number(high.toFixed(2))])).toEqual([[0.57, 1], [0, 0.43]])
  }, 60_000)

  test("a script that repeats the message fails the text tasks, whose message holds the answer: the grader of the answer refuses a copy", async () => {
    const parrot: ModelScript = [
      ...fives(says('You said: "What is 2 + 3?".')),
      ...fives(says('You said: "What is 12 * 3?".')),
      ...fives(says('You said: "The meeting is on Tuesday. When is the meeting?".')),
      ...fives(says('You said: "The keys are under the mat. Where are the keys?".')),
    ]
    const run = await ran(write("parrot"), { echo: ECHO_LIKE, parrot })
    expect(run.passes("parrot")).toBe(0)
    expect(run.reasons("parrot", "meeting")).toEqual(["answer: the answer repeats the message", "tool: it called no tool"])
    // With the lenient grader, the same copies pass, and so would any answer at all.
    const lenient = await ran(write("parrot-lenient", { evals: applied("lenient").evals ?? "" }), { echo: ECHO_LIKE, parrot })
    expect(lenient.passes("parrot")).toBe(20)
    expect(lenient.reasons("parrot", "meeting")).toEqual(["answer: there is an answer", "tool: it called no tool"])
  }, 60_000)

  test("a candidate whose model fails every call: its turns end failed, each trial completes with no answer and fails, a regression", async () => {
    const failing: ModelScript = Array.from({ length: 20 }, () => ({ _tag: "Fails" as const }))
    const run = await ran(write("down"), { echo: ECHO_LIKE, down: failing })
    expect(run.statuses("down")).toEqual(["completed"])
    expect(run.reasons("down", "meeting")).toEqual(['answer: the answer does not hold "Tuesday"', "tool: it called no tool"])
    expect(run.comparison).toEqual([["echo", 20, 20, []], ["down", 0, 20, ["sum", "product", "meeting", "keys"]]])
    expect(run.infrastructure).toEqual([["echo", 0], ["down", 0]])
  })

  test("the answer's grader compares letters exactly: Under the mat. fails under the mat, as a real model answered", async () => {
    const script: ModelScript = [
      ...fives(calls("calculator", { a: 2, op: "+", b: 3 }), says("The tool answered: calculator says 5.")),
      ...fives(calls("calculator", { a: 12, op: "*", b: 3 }), says("The tool answered: calculator says 36.")),
      ...fives(says("The meeting is on Tuesday.")),
      ...fives(says("Under the mat.")),
    ]
    const run = await ran(write("graders"), { echo: ECHO_LIKE, other: script })
    expect(run.reasons("other", "keys")).toEqual(['answer: the answer does not hold "under the mat"', "tool: it called no tool"])
  })

  test("what a grader can get wrong: the message repeated with one word more passes, the answer in other words fails, and the same input in another order fails", async () => {
    const script: ModelScript = [
      // The sums: the right numbers, written in another order than the reference's.
      ...fives(calls("calculator", { b: 3, op: "+", a: 2 }), says("The tool answered: calculator says 5.")),
      ...fives(calls("calculator", { a: 12, op: "*", b: 3 }), says("The tool answered: calculator says 36.")),
      // The message repeated with one word more: no copy of it, word for word, so it passes.
      ...fives(says("The meeting is on Tuesday. When is the meeting, then?")),
      // The right place, in other words.
      ...fives(says("They are under the doormat.")),
    ]
    const run = await ran(write("graders"), { echo: ECHO_LIKE, other: script })
    expect(run.reasons("other", "sum")).toEqual(['answer: the answer holds "5"', 'tool: it called calculator({"b":3,"op":"+","a":2}), not calculator({"a":2,"op":"+","b":3})'])
    expect(run.reasons("other", "meeting")).toEqual(['answer: the answer holds "Tuesday"', "tool: it called no tool"])
    expect(run.reasons("other", "keys")).toEqual(['answer: the answer does not hold "under the mat"', "tool: it called no tool"])
  }, 60_000)

  test("the program never sees a reference: a trial's model is sent the system text and the task's message, and then the tool's result", async () => {
    const { run }: { readonly run: Run } = await import(new URL("./runnable.ts", write("prompts")).href)
    const made = await Effect.runPromise(scriptedModel(ECHO_LIKE))
    await Effect.runPromise(run({ echo: made.model }, () => {}))
    const sent = await Effect.runPromise(made.calls)
    const SYSTEM = { role: "system", text: "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence." }
    expect(sent.slice(0, 2)).toEqual([
      [SYSTEM, { role: "user", text: "What is 2 + 3?" }],
      [SYSTEM, { role: "user", text: "What is 2 + 3?" }, { role: "assistant", text: 'calculator({"a":2,"op":"+","b":3})' }, { role: "tool", text: "→ 5" }],
    ])
    // Two calls for each sum and one for each question, five times each: thirty prompts, none holding a reference's words.
    expect(sent).toHaveLength(30)
    expect(sent.flat().filter((message) => /written by hand|holds|reference/.test(message.text))).toEqual([])
  }, 60_000)

  test("one trial at a time, each limited to two minutes, as a live check of lesson 12 is", () => {
    expect(times(RUNNABLE, "      concurrency: 1,\n")).toBe(1)
    expect(times(RUNNABLE, "      timeoutMs: 120_000,\n")).toBe(1)
  })

  test("type-checks as TypeScript, all six files, as shown and as each experiment leaves them", () => {
    write("typed")
    for (const id of Object.keys(evalsLesson.experiments)) write(`typed-${id}`, applied(id))
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
