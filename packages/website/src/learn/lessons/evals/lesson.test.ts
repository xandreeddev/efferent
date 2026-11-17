// Lesson 13 on the page's runtime, with Echo: "Run evals" runs the suite of
// evals.ts once for each candidate, each trial on a stack of its own, and the
// table fills as trials end, with each task's passes, their interval, the
// gates, the suite's verdict and the comparison with Echo; the page hears
// nothing of a run; the run and the chat take turns; Stop interrupts a run
// and what it finished stays; an evals.ts that makes no dataset is refused
// in words; and each experiment does what the page says. A real model's
// rates are not pinned here: the mdx says what one did.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Context, Effect, Exit, Layer, Option, Result } from "effect"
import { LanguageModel } from "effect/ai"
import { scriptedModel } from "@xandreed/sdk/kernel"
import type { ModelScript } from "@xandreed/sdk/kernel"
import { applyExperiment } from "../../lesson.ts"
import { makeBrowserModel } from "../../models/make.ts"
import { loadEcho } from "../../models/mock.ts"
import { modelStream } from "../../models/stream.ts"
import type { LoadedModel } from "../../models/types.ts"
import { LessonRuntime, TURN_RUNNING } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import type { EvalsView } from "./board.ts"
import { evalsLesson } from "./lesson.ts"

// Echo streams a word every 35 ms: a run of forty trials on two Echoes takes about fifteen seconds.
setDefaultTimeout(90_000)

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES: Record<string, string> = Object.fromEntries(evalsLesson.files.map((file) => [file.id, file.defaultText]))
/** The sources as an experiment leaves them: every file it edits. */
const applied = (id: string, sources = SOURCES): Record<string, string> =>
  ({ ...sources, ...Object.fromEntries(Option.getOrThrow(Option.flatMap(Option.fromNullishOr(evalsLesson.experiments[id]), (experiment) => applyExperiment(experiment, (file) => sources[file] ?? "")))) })

const evals = Option.getOrThrow(Option.fromNullishOr(evalsLesson.evals))

/** A model that follows a script, as the model picked, under the name `id`. */
const scripted = async (id: string, script: ModelScript): Promise<LoadedModel> => {
  const made = await Effect.runPromise(scriptedModel(script))
  const model = await Effect.runPromise(Effect.scoped(Effect.map(Layer.build(made.model), (built) => Context.get(built, LanguageModel.LanguageModel))))
  return { choice: { id, kind: "echo", label: "Scripted", blurb: "A model that follows a script.", memoryMB: 0 }, model, interrupt: () => {}, dispose: () => {} }
}

/** The page: the runtime on a model (Echo when none is given), what it heard, and "Run evals" as the button presses it. */
const page = async (sources: Record<string, string> = SOURCES, model: LoadedModel = loadEcho()) => {
  const runtime = await LessonRuntime.create(evalsLesson)
  opened.push(runtime)
  runtime.setModel(model)
  const heard: Array<Trace> = []
  runtime.onTrace((trace) => { heard.push(trace) })
  const result = await runtime.start(sources)
  /** Run evals, as the button does: every view the table was drawn from, the last one, and how the run ended. */
  const run = async (over: Record<string, string> = sources, onView: (view: EvalsView) => void = () => {}) => {
    const views: Array<EvalsView> = []
    const ran = await runtime.runAlone(evals.start(over, (view) => { views.push(view); onView(view) }))
    return { ran, views, last: views.at(-1) }
  }
  const say = (text: string) => new Promise<string>((resolve) => {
    const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply") { stop(); resolve(trace.text) } })
    runtime.send(text)
  })
  /** Everything of the page a run could have touched: what it heard, its conversation's journal, its store. */
  const seen = async () => ({ traces: heard.length, journal: await runtime.journal(), sessions: (await runtime.list()).map((header) => header.owner) })
  return { runtime, heard, result, run, say, seen }
}

/** A view's table as lines: each candidate's line, each task's, and each gate's. */
const table = (view: EvalsView | undefined) => (view?.candidates ?? []).map((candidate) => ({
  candidate: candidate.candidate, line: candidate.line, tasks: candidate.tasks.map((task) => `${task.task}: ${task.line}`), gates: candidate.gates.map((gate) => gate.line),
}))

const ALL_PASSED = ["sum: 5 of 5 passed (0.57 to 1)", "product: 5 of 5 passed (0.57 to 1)", "meeting: 5 of 5 passed (0.57 to 1)", "keys: 5 of 5 passed (0.57 to 1)"]
const NO_TOOLS = ["sum: 0 of 5 passed (0 to 0.43)", "product: 0 of 5 passed (0 to 0.43)", "meeting: 5 of 5 passed (0.57 to 1)", "keys: 5 of 5 passed (0.57 to 1)"]
const ECHO_GATE = "✓ answer@1 holds at least 0.8, blocking: measured 1 (Passed)"
const NO_TOOLS_GATE = "✗ answer@1 holds at least 0.8, blocking: measured 0.5 (Outside threshold)"
const BLOCKED = "The suite is blocked: echo-no-tools failed a blocking gate."
const STARTER_TABLE = [
  { candidate: "echo", line: "20 of 20 passed (0.84 to 1)", tasks: ALL_PASSED, gates: [ECHO_GATE] },
  { candidate: "echo-no-tools", line: "10 of 20 passed (0.3 to 0.7)", tasks: NO_TOOLS, gates: [NO_TOOLS_GATE] },
]
const STARTER_COMPARISON = ["echo (the baseline): 20 of 20 passed", "echo-no-tools: 10 of 20 passed; regressions against Echo: sum, product"]

describe("lesson 13 on the page (the kernel, Echo)", () => {
  test("Run evals on a new page: Echo passes every task, echo-no-tools half, with intervals, gates, a verdict and the comparison; the page heard nothing", async () => {
    const { result, run, seen } = await page()
    expect(result).toEqual({ _tag: "Built" })
    const before = await seen()
    expect(before).toEqual({ traces: 0, journal: [], sessions: ["learner"] })
    const { ran, views, last } = await run()
    expect(Result.isSuccess(ran) && Exit.isSuccess(ran.success)).toBe(true)
    expect(last?.status).toBe("Done: 40 of 40 trials ran, each graded.")
    expect(table(last)).toEqual(STARTER_TABLE)
    expect(last?.verdict).toBe(BLOCKED)
    expect(last?.comparison).toEqual(STARTER_COMPARISON)
    // Each trial on demand: its grades' reasons, and its transcript, the records its turn stored.
    const sum = last?.candidates[1]?.tasks[0]?.trials[0]
    expect(sum?.label).toBe("sample 1: failed")
    expect(sum?.grades).toEqual(["answer@1: the answer repeats the message", 'tool@1: it called no tool, not calculator({"a":2,"op":"+","b":3})'])
    expect(sum?.transcript.map((line) => line.split(" ")[0])).toEqual(["core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "core.session.turn.ended"])
    expect(last?.candidates[0]?.tasks[0]?.trials[0]?.grades).toEqual(['answer@1: the answer holds "5"', 'tool@1: it called calculator({"a":2,"op":"+","b":3})'])
    expect(last?.candidates[0]?.tasks[0]?.trials[0]?.transcript[3]).toMatch(/^conversation\.tool\.result \{"_tag":"ToolResult","id":"[^"]+","name":"calculator","result":5,"isFailure":false\}$/)
    // The table filled as trials ended: the count only grew, and Echo's tasks were graded while echo-no-tools still ran.
    const counts = views.map((view) => Number(/^(?:Done: )?(\d+) of 40/.exec(view.status)?.[1] ?? -1))
    expect(counts[0]).toBe(0)
    expect(counts.every((count, index) => index === 0 || count >= (counts[index - 1] ?? 0))).toBe(true)
    expect(views.some((view) => view.candidates[0]?.line === "20 of 20 passed (0.84 to 1)" && /^ran \d+ of 20$/.test(view.candidates[1]?.line ?? ""))).toBe(true)
    // The page heard nothing of forty trials: no trace, no record, no session in its store.
    expect(await seen()).toEqual(before)
  })

  test("the chat answers each kind of task: a sum with the calculator, and a message answered from what it says", async () => {
    const { runtime, result, say } = await page()
    expect(result).toEqual({ _tag: "Built" })
    expect(evalsLesson.chips).toEqual(["What is 2 + 3?", "What is 12 * 3?", "The meeting is on Tuesday. When is the meeting?", "The keys are under the mat. Where are the keys?"])
    expect(await say("What is 2 + 3?")).toBe("The tool answered: calculator says 5.")
    expect(await say("The meeting is on Tuesday. When is the meeting?")).toBe("The meeting is on Tuesday.")
    // "Send three at once": one turn takes the three, works out both sums, and answers from the tools' results.
    expect(evalsLesson.three).toEqual(evalsLesson.chips.slice(0, 3))
    const together = new Promise<string>((resolve) => {
      const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply") { stop(); resolve(trace.text) } })
    })
    evalsLesson.three.forEach((text) => runtime.send(text))
    // Echo answers from the tools' results alone: the question about the meeting goes unanswered in that turn.
    expect(await together).toBe("The tools answered: calculator says 5; calculator says 36.")
  })

  test("a run the eval package refuses (a gate on a grader that is none) ends in the package's words, and the table says the evals did not run to the end", async () => {
    const { run } = await page()
    const wrong = { ...SOURCES, evals: SOURCES.evals?.replace('grader: "answer@1",', 'grader: "answers@1",') ?? "" }
    const { ran, last } = await run(wrong)
    expect(Result.isSuccess(ran) && Exit.isSuccess(ran.success)).toBe(true)
    expect(last?.status).toBe('The evals did not run to the end: Evaluation app refused (2 violations): gate-unbound at suites.0.gates.0.grader: no task of suite "lesson" binds grader "answers@1"; grader-unknown at suites.0.gates.0.grader: grader "answers@1" is not registered')
    // Nothing ran: no candidate has a trial, and there is no verdict or comparison.
    expect(last?.candidates.map((candidate) => candidate.line)).toEqual(["ran 0 of 20, not graded", "ran 0 of 20, not graded"])
    expect([last?.verdict, last?.comparison]).toEqual(["", []])
  })

  test("the run and the chat take turns: Run evals is refused while a turn runs, the page is told while a run runs, and the chat answers after it", async () => {
    const { runtime, run, say } = await page(applied("once"))
    const replied = say("What is 2 + 3?")
    // The turn is open once its first record is stored.
    await new Promise<void>((resolve) => { const stop = runtime.onTrace((trace) => { if (trace._tag === "Event") { stop(); resolve() } }) })
    expect(runtime.busy).toBe(true)
    expect((await run()).ran).toEqual(Result.fail(TURN_RUNNING))
    expect(await replied).toBe("The tool answered: calculator says 5.")
    const running = run()
    expect(runtime.checking).toBe(true)
    expect((await run()).ran).toEqual(Result.fail("it is running already."))
    expect((await running).last?.status).toBe("Done: 8 of 8 trials ran, each graded.")
    expect(runtime.checking).toBe(false)
    expect(await say("What is 12 * 3?")).toBe("The tool answered: calculator says 36.")
  })

  test("with a model picked that is not Echo, it is a third candidate, compared with Echo; each trial is limited to two minutes", async () => {
    // A model that answers every message with the same words: it calls no tool, and holds no reference.
    const { run, seen } = await page(SOURCES, await scripted("scripted", [{ _tag: "Answers", pieces: ["I do not know."] }]))
    const before = await seen()
    const { views, last } = await run()
    // Three candidates, four tasks, five times each: sixty trials.
    expect(views[0]?.status).toBe("0 of 60 trials ran.")
    expect(last?.status).toBe("Done: 60 of 60 trials ran, each graded.")
    expect(last?.candidates.map((candidate) => [candidate.candidate, candidate.line])).toEqual([
      ["echo", "20 of 20 passed (0.84 to 1)"], ["echo-no-tools", "10 of 20 passed (0.3 to 0.7)"], ["scripted", "0 of 20 passed (0 to 0.16)"],
    ])
    expect(last?.comparison[2]).toBe("scripted: 0 of 20 passed; regressions against Echo: sum, product, meeting, keys")
    expect(last?.verdict).toBe("The suite is blocked: echo-no-tools, scripted failed a blocking gate.")
    expect(await seen()).toEqual(before)
  })

  test("Stop interrupts a run: the run says so, the candidates it finished stay graded, and the model's stream is cancelled", async () => {
    // A model that starts an answer and never ends it, built as the page's models are: over a source with a cancel.
    let started = 0
    let cancelled = 0
    /** What the test does once the stalled model has started its answer: Stop, as the button does. */
    let onStart = () => {}
    const stalled: LoadedModel = {
      choice: { id: "stalled", kind: "echo", label: "Stalled", blurb: "A model that never ends its answer.", memoryMB: 0 },
      model: makeBrowserModel("stalled", {
        generateText: () => Effect.die("the stalled model only streams"),
        streamText: () => modelStream("Stalled", (sink) => { started++; sink.push("One"); onStart(); return () => { cancelled++ } }) as never,
      }, "native"),
      interrupt: () => {},
      dispose: () => {},
    }
    const { runtime, run } = await page(applied("once"), stalled)
    // Stop once the stalled model has started its first answer, in its first trial.
    let stopping: Promise<void> | undefined
    onStart = () => { stopping = runtime.stopAlone() }
    const { ran, last } = await run(applied("once"))
    await stopping
    expect(Result.isSuccess(ran) && Exit.hasInterrupts(ran.success)).toBe(true)
    expect(last?.status).toBe("Stopped: 8 of 12 trials ran. A candidate's trials are graded once they have all run, so a candidate cut short has none graded.")
    expect(table(last).map((candidate) => [candidate.candidate, candidate.line])).toEqual([
      ["echo", "4 of 4 passed (0.51 to 1)"], ["echo-no-tools", "2 of 4 passed (0.15 to 0.85)"], ["stalled", last?.candidates[2]?.line ?? ""],
    ])
    expect(last?.candidates[2]?.line).toBe("ran 0 of 4, not graded")
    // The trial cut short says so, with the runner's reason.
    expect(last?.candidates[2]?.tasks[0]?.trials.map((trial) => [trial.label, trial.reason])).toEqual([["sample 1: cancelled", "cancelled: interrupted"]])
    // No verdict and no comparison: the run did not end.
    expect([last?.verdict, last?.comparison]).toEqual(["", []])
    expect([started, cancelled]).toEqual([1, 1])
    expect(runtime.checking).toBe(false)
  })

  test("an evals.ts that makes no dataset is refused, by the build and by Run evals, in words that name the file", async () => {
    const { runtime, run } = await page()
    const none = "evals.ts did not run: dataset is not a dataset. It should be { id, version, input, reference, cases }, with input and reference schemas and cases a list."
    const wrong = { ...SOURCES, evals: SOURCES.evals?.replace("export const dataset = {", "export const dataset = 42\nconst unused = {") ?? "" }
    expect(await runtime.start(wrong)).toEqual({ _tag: "Refused", message: none })
    expect((await run(wrong)).ran).toEqual(Result.fail(none))
    // With no model picked there is nothing to run the evals on.
    const bare = await LessonRuntime.create(evalsLesson)
    opened.push(bare)
    expect(await bare.runAlone(evals.start(SOURCES, () => {}))).toEqual(Result.fail("Pick a model first."))
  })

  test("a lenient grader (an experiment) passes every trial, a calculator that subtracts and a copy of the message alike", async () => {
    const { run } = await page(applied("lenient"))
    const { last } = await run()
    expect(table(last)).toEqual([
      { candidate: "echo", line: "20 of 20 passed (0.84 to 1)", tasks: ALL_PASSED, gates: [ECHO_GATE] },
      { candidate: "echo-no-tools", line: "20 of 20 passed (0.84 to 1)", tasks: ALL_PASSED, gates: ["✓ answer@1 holds at least 0.8, blocking: measured 1 (Passed)"] },
    ])
    expect(last?.verdict).toBe("Every candidate passed every blocking gate.")
    expect(last?.comparison).toEqual(["echo (the baseline): 20 of 20 passed", "echo-no-tools: 20 of 20 passed; no regression against Echo"])
    const sum = last?.candidates[0]?.tasks[0]?.trials[0]
    expect(sum?.grades[0]).toBe("answer@1: there is an answer")
    expect(sum?.transcript.at(-2)).toContain("The tool answered: calculator says -1.")
  })

  test("each task once (an experiment): one pass is an interval from 0.21 to 1", async () => {
    const { run } = await page(applied("once"))
    const { last } = await run()
    expect(last?.status).toBe("Done: 8 of 8 trials ran, each graded.")
    expect(table(last)).toEqual([
      { candidate: "echo", line: "4 of 4 passed (0.51 to 1)", tasks: ALL_PASSED.map((line) => line.replace("5 of 5 passed (0.57 to 1)", "1 of 1 passed (0.21 to 1)")), gates: [ECHO_GATE] },
      {
        candidate: "echo-no-tools", line: "2 of 4 passed (0.15 to 0.85)",
        tasks: ["sum: 0 of 1 passed (0 to 0.79)", "product: 0 of 1 passed (0 to 0.79)", "meeting: 1 of 1 passed (0.21 to 1)", "keys: 1 of 1 passed (0.21 to 1)"], gates: [NO_TOOLS_GATE],
      },
    ])
  })

  test("a strict gate (an experiment): a second blocking gate, on the tool's grader, at every trial; Echo passes both, echo-no-tools neither", async () => {
    const { run } = await page(applied("strict-gate"))
    const { last } = await run()
    expect(table(last).map((candidate) => [candidate.candidate, candidate.line, candidate.gates])).toEqual([
      ["echo", "20 of 20 passed (0.84 to 1)", [ECHO_GATE, "✓ tool@1 called at least 1, blocking: measured 1 (Passed)"]],
      ["echo-no-tools", "10 of 20 passed (0.3 to 0.7)", [NO_TOOLS_GATE, "✗ tool@1 called at least 1, blocking: measured 0.5 (Outside threshold)"]],
    ])
    expect(last?.verdict).toBe(BLOCKED)
  })

  test("a reference no one has reviewed: the gate gate() made does not pass while one of its trials' references is provisional, Echo's included", async () => {
    const evals = SOURCES.evals?.replace('review: "reviewed"', 'review: "provisional"') ?? ""
    expect(evals).toContain('review: "provisional"')
    const { run } = await page({ ...SOURCES, evals })
    const { last } = await run()
    expect(table(last).map((candidate) => [candidate.candidate, candidate.gates])).toEqual([
      ["echo", ["✗ answer@1 holds at least 0.8, blocking: measured 1 (Reference labels need review)"]],
      ["echo-no-tools", ["✗ answer@1 holds at least 0.8, blocking: measured 0.5 (Reference labels need review)"]],
    ])
  })

  test("a task Echo misses (an experiment): Echo's rate falls, and no candidate regresses on it, since the baseline failed it too", async () => {
    const { run } = await page(applied("baseline-misses"))
    const { last } = await run()
    expect(table(last)).toEqual([
      { candidate: "echo", line: "20 of 25 passed (0.61 to 0.91)", tasks: [...ALL_PASSED, "day: 0 of 5 passed (0 to 0.43)"], gates: ["✓ answer@1 holds at least 0.8, blocking: measured 0.8 (Passed)"] },
      { candidate: "echo-no-tools", line: "10 of 25 passed (0.23 to 0.59)", tasks: [...NO_TOOLS, "day: 0 of 5 passed (0 to 0.43)"], gates: ["✗ answer@1 holds at least 0.8, blocking: measured 0.4 (Outside threshold)"] },
    ])
    expect(last?.candidates[0]?.tasks[4]?.trials[0]?.grades[0]).toBe("answer@1: the answer repeats the message")
    expect(last?.comparison).toEqual(["echo (the baseline): 20 of 25 passed", "echo-no-tools: 10 of 25 passed; regressions against Echo: sum, product"])
  })

  test("the lesson's files, experiments and buttons", () => {
    expect(evalsLesson.files.map((file) => [file.id, file.readOnly])).toEqual([["evals", false], ["runnable", true], ["agent", true], ["tools", false], ["chat", true], ["memory", true]])
    expect(evalsLesson.mainFile).toBe("evals")
    expect(Object.entries(evalsLesson.experiments).map(([id, experiment]) => [id, experiment.file, (experiment.also ?? []).map((edit) => edit.file)])).toEqual([
      ["lenient", "evals", ["tools"]], ["once", "evals", []], ["strict-gate", "evals", []], ["baseline-misses", "evals", []],
    ])
    expect(evalsLesson.controls).toEqual({})
    expect(evalsLesson.kits).toBeUndefined()
    // The lesson is not durable: a reload starts from the starter code and an empty conversation.
    expect(evalsLesson.durable).toBeUndefined()
  })
})
