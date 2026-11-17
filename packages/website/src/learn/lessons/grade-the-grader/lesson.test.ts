// Lesson 19 on the page's runtime, with Echo picked: "Check the graders"
// checks each grader of graders.ts against the labels of labels.ts with the
// eval package's calibration, and the table fills as checks end, with each
// grader's agreement, false passes and false fails, each case's verdicts and
// their reasons, and who answered for Jev; the page hears nothing of a check;
// the check and the chat take turns; Stop interrupts a check; a labels.ts or a
// graders.ts that makes the wrong thing is refused in words; and each
// experiment does what the page says. No test reaches the gateway: the real
// Jev's path runs over a fake `fetch`, and what the real Jev gives is not
// pinned here.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Effect, Exit, Option, Result, Schema } from "effect"
import { applyExperiment } from "../../lesson.ts"
import { forgetGatewayKey } from "../../models/gateway-key.ts"
import type { Fetch } from "../../models/gateway.ts"
import { loadEcho } from "../../models/mock.ts"
import { LessonRuntime, TURN_RUNNING } from "../../runtime.ts"
import type { GradersView } from "./board.ts"
import { gradeTheGrader } from "./lesson.ts"
import { JEV_LINE, STAND_IN_LINE, startCheck } from "./run.ts"
import { NOT_RECORDED, recordedAnswers } from "./stand-in.ts"

setDefaultTimeout(60_000)

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES: Record<string, string> = Object.fromEntries(gradeTheGrader.files.map((file) => [file.id, file.defaultText]))
/** The sources as an experiment leaves them: every file it edits. */
const applied = (id: string, sources = SOURCES): Record<string, string> =>
  ({ ...sources, ...Object.fromEntries(Option.getOrThrow(Option.flatMap(Option.fromNullishOr(gradeTheGrader.experiments[id]), (experiment) => applyExperiment(experiment, (file) => sources[file] ?? "")))) })

const NO_KEY = () => Option.none<string>()
const A_KEY = () => Option.some("vck_test")

/**
 * A fake of the gateway's `/v1/decisions`, shaped like its reply: each predicate answered from Jev's recorded answers
 * to the same request, or with `otherwise` for a request Jev was never asked. `hold` keeps every request waiting
 * until it is aborted, and says it started.
 */
const fakeGateway = (options: { readonly otherwise?: number; readonly hold?: (signal: AbortSignal) => void; readonly refuse?: string; readonly status?: number } = {}) => {
  const sent: Array<{ readonly input: string; readonly names: ReadonlyArray<string> }> = []
  const Body = Schema.fromJsonString(Schema.Struct({ input: Schema.String, questions: Schema.Array(Schema.Struct({ name: Schema.String, instructions: Schema.String })) }))
  const fetchFn: Fetch = (_url, init) => {
    const body = Schema.decodeUnknownSync(Body)(init.body)
    sent.push({ input: body.input, names: body.questions.map((question) => question.name) })
    if (options.hold !== undefined) {
      options.hold(init.signal)
      return new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(new Error("aborted"))) })
    }
    const recorded = recordedAnswers({ state: body.input, questions: Object.fromEntries(body.questions.map((question) => [question.name, { type: "boolean", instructions: question.instructions }])) })
    if (options.status !== undefined) return Promise.resolve(new Response(JSON.stringify({ error: { message: "busy" } }), { status: options.status }))
    const answers = body.questions.map((question) => question.name === options.refuse ? { type: "refusal", name: question.name } : {
      type: "predicate", name: question.name,
      probability: Option.getOrElse(Option.flatMap(recorded, (found) => Option.fromNullishOr(found[question.name])), () => options.otherwise ?? 0.5),
    })
    return Promise.resolve(new Response(JSON.stringify({ answers, model: "typesafe-ai/jev", usage: { input_tokens: 90, output_tokens: 0, total_tokens: 90 } }), { status: 200 }))
  }
  return { fetchFn, sent }
}

/** The page: the runtime on Echo, what it heard, and "Check the graders" as the button presses it. */
const page = async (sources: Record<string, string> = SOURCES) => {
  const runtime = await LessonRuntime.create(gradeTheGrader)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<unknown> = []
  runtime.onTrace((trace) => { heard.push(trace) })
  const result = await runtime.start(sources)
  /** Check the graders, as the button does, with the key `keyOf` gives and the gateway `fetchFn` fakes. */
  const check = async (over: Record<string, string> = sources, keyOf: () => Option.Option<string> = NO_KEY, fetchFn?: Fetch) => {
    const views: Array<GradersView> = []
    const ran = await runtime.runAlone(startCheck(over, (view) => { views.push(view) }, keyOf, fetchFn))
    return { ran, views, last: views.at(-1) }
  }
  const say = (text: string) => new Promise<string>((resolve) => {
    const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply") { stop(); resolve(trace.text) } })
    runtime.send(text)
  })
  /** Everything of the page a check could have touched: what it heard, its conversation's journal, its store. */
  const seen = async () => ({ traces: heard.length, journal: await runtime.journal(), sessions: (await runtime.list()).map((header) => header.owner) })
  return { runtime, result, check, say, seen }
}

/** Each grader's line, as the table draws it. */
const lines = (view: GradersView | undefined) => (view?.graders ?? []).map((grader) => `${grader.grader}: ${grader.line}`)
/** One grader's cell of one case: its mark and its reason. */
const cell = (view: GradersView | undefined, id: string, grader: string) => {
  const found = view?.cases.find((one) => one.id === id)?.cells.find((one) => one.grader === grader)
  return [found?.mark, found?.reason]
}

const TEXT = "text: agrees with 2 of 8; false passes: 5, 6, 7, 8; false fails: 2, 3"
const ONCE = "asked-once: agrees with 5 of 8; false passes: 5, 6, 7; false fails: none"
const THRICE = "asked-thrice: agrees with 7 of 8; false passes: none; false fails: 4"
const STARTER = [TEXT, ONCE, THRICE]

describe("lesson 19 on the page (the kernel, Echo, the stand-in for Jev)", () => {
  test("Check the graders on a new page: text agrees with 2 of 8, asked-once with 5, asked-thrice with 7; the stand-in answered; the page heard nothing", async () => {
    const { result, check, seen } = await page()
    expect(result).toEqual({ _tag: "Built" })
    const before = await seen()
    expect(before).toEqual({ traces: 0, journal: [], sessions: ["learner"] })
    const { ran, views, last } = await check()
    expect(Result.isSuccess(ran) && Exit.isSuccess(ran.success)).toBe(true)
    expect(views[0]?.status).toBe("Checking: 0 of 24 checks graded.")
    expect(last?.status).toBe("Done: 24 of 24 checks graded.")
    expect(lines(last)).toEqual(STARTER)
    // A row for each labelled answer: what was asked and answered, and the label a person wrote.
    expect(last?.cases.map((one) => [one.id, one.label])).toEqual([["1", "right"], ["2", "right"], ["3", "right"], ["4", "right"], ["5", "wrong"], ["6", "wrong"], ["7", "wrong"], ["8", "wrong"]])
    expect(last?.cases[7]?.text).toBe("What is the capital of Portugal? Porto, not Lisbon.")
    // Each grader's verdict against the label, ✓ where they match, and its reason on demand.
    expect(last?.cases.map((one) => one.cells.map((each) => each.mark))).toEqual([
      ["yes ✓", "yes ✓", "yes ✓"], ["no ✗", "yes ✓", "yes ✓"], ["no ✗", "yes ✓", "yes ✓"], ["yes ✓", "yes ✓", "no ✗"],
      ["yes ✗", "yes ✗", "no ✓"], ["yes ✗", "yes ✗", "no ✓"], ["yes ✗", "yes ✗", "no ✓"], ["yes ✗", "no ✓", "no ✓"],
    ])
    expect(last?.judge).toBe(STAND_IN_LINE)
    expect(STAND_IN_LINE).toBe("The stand-in answered for Jev: Jev's own answers to the starter's 16 requests, recorded on 17 November 2026, each the middle of five runs. Keep an AI Gateway key in the model list, and the real Jev answers. With a key, a press with the starter's files sends Jev 16 requests, and costs less than a tenth of a cent.")
    // The table filled as checks were graded: the count only grew, and text was done while the others were not.
    const counts = views.map((view) => Number(/(\d+) of 24/.exec(view.status)?.[1] ?? -1))
    expect(counts.every((count, index) => index === 0 || count >= (counts[index - 1] ?? 0))).toBe(true)
    expect(views.some((view) => view.graders[0]?.line === TEXT.slice("text: ".length) && view.graders[2]?.line === "not checked yet")).toBe(true)
    expect(views.some((view) => /^checked [1-7] of 8 so far, agrees with \d$/.test(view.graders[1]?.line ?? ""))).toBe(true)
    // The page heard nothing of twenty-four checks: no trace, no record, no session in its store.
    expect(await seen()).toEqual(before)
  })

  test("what the page says of each grader: the text grader's reasons, and Jev's probabilities in the model graders' reasons", async () => {
    const { check } = await page()
    const { last } = await check()
    expect(cell(last, "8", "text")).toEqual(["yes ✗", 'the answer holds "Lisbon"'])
    expect(cell(last, "2", "text")).toEqual(["no ✗", 'the answer does not hold "5"'])
    expect(cell(last, "3", "text")).toEqual(["no ✗", 'the answer does not hold "Lisbon"'])
    // asked-once reads Five. and Lisboa. as right; it passes 5, 6 and 7, each giving the reference answer; 8 fails.
    expect(["2", "3", "5", "6", "7", "8"].map((id) => cell(last, id, "asked-once")[1])).toEqual([
      "gives the reference answer: 0.98", "gives the reference answer: 0.7", "gives the reference answer: 0.94",
      "gives the reference answer: 0.98", "gives the reference answer: 0.95", "gives the reference answer: 0.37",
    ])
    // asked-thrice fails 5 and 6 on something false, 7 on committing, 8 on the reference answer, and 4 on committing.
    expect(["4", "5", "6", "7", "8"].map((id) => cell(last, id, "asked-thrice")[1])).toEqual([
      "gives the reference answer: 0.93; says something false: 0.11; commits to one answer: 0.29",
      "gives the reference answer: 0.94; says something false: 0.94; commits to one answer: 0.9",
      "gives the reference answer: 0.99; says something false: 0.98; commits to one answer: 0.64",
      "gives the reference answer: 0.95; says something false: 0.51; commits to one answer: 0.08",
      "gives the reference answer: 0.37; says something false: 0.98; commits to one answer: 0.8",
    ])
  })

  test("the lesson's own button, with no key kept, checks on the stand-in", async () => {
    forgetGatewayKey()
    const { runtime } = await page()
    const start = Option.getOrThrow(Option.fromNullishOr(gradeTheGrader.calibration)).start
    const views: Array<GradersView> = []
    await runtime.runAlone(start(SOURCES, (view) => { views.push(view) }))
    expect(lines(views.at(-1))).toEqual(STARTER)
    expect(views.at(-1)?.judge).toBe(STAND_IN_LINE)
  })

  test("with a key kept, Jev answers through the gateway: the same numbers, in sixteen requests, and the line says so", async () => {
    const { check } = await page()
    const gateway = fakeGateway()
    const { last } = await check(SOURCES, A_KEY, gateway.fetchFn)
    expect(lines(last)).toEqual(STARTER)
    expect(last?.judge).toBe(JEV_LINE)
    expect(JEV_LINE).toBe("Jev was asked, through the AI Gateway with your key. With a key, a press with the starter's files sends Jev 16 requests, and costs less than a tenth of a cent.")
    // Eight requests for asked-once, one predicate each, and eight for asked-thrice, its three in one request.
    expect(gateway.sent.map((one) => one.names.join(", "))).toEqual([...Array.from({ length: 8 }, () => "gives"), ...Array.from({ length: 8 }, () => "gives, false, commits")])
  })

  test("with a key, a question Jev refuses and a gateway that fails each leave a check with no grade, said in the cell and counted as a disagreement", async () => {
    const { check } = await page()
    const refused = await check(SOURCES, A_KEY, fakeGateway({ refuse: "commits" }).fetchFn)
    // asked-once asks no commits, and agrees as on the stand-in; asked-thrice gets no grade on any case.
    expect(lines(refused.last)).toEqual([TEXT, ONCE, "asked-thrice: agrees with 0 of 8; false passes: none; false fails: none; no grade: 1, 2, 3, 4, 5, 6, 7, 8"])
    expect(cell(refused.last, "1", "asked-thrice")).toEqual(["no grade ✗", 'Jev request failed: The decision model gave no answer to "commits": it refused it, or answered in a shape the question does not have.'])
    const busy = await check(SOURCES, A_KEY, fakeGateway({ status: 429 }).fetchFn)
    expect(lines(busy.last)).toEqual([
      TEXT,
      "asked-once: agrees with 0 of 8; false passes: none; false fails: none; no grade: 1, 2, 3, 4, 5, 6, 7, 8",
      "asked-thrice: agrees with 0 of 8; false passes: none; false fails: none; no grade: 1, 2, 3, 4, 5, 6, 7, 8",
    ])
    expect(cell(busy.last, "5", "asked-once")).toEqual(["no grade ✗", "Jev request failed: the gateway is busy, too many requests at once: check the graders again in a moment."])
  })

  test("a case of your own (an experiment): the text grader fails it; on the stand-in the model graders give it no grade, counted as a disagreement; with a key Jev is asked", async () => {
    const { check } = await page(applied("your-own-case"))
    const { last } = await check(applied("your-own-case"))
    expect(lines(last)).toEqual([
      "text: agrees with 2 of 9; false passes: 5, 6, 7, 8; false fails: 2, 3, 9",
      "asked-once: agrees with 5 of 9; false passes: 5, 6, 7; false fails: none; no grade: 9",
      "asked-thrice: agrees with 7 of 9; false passes: none; false fails: 4; no grade: 9",
    ])
    expect(last?.cases[8]?.text).toBe("How many legs does a spider have? Eight.")
    expect(cell(last, "9", "text")).toEqual(["no ✗", 'the answer does not hold "8"'])
    expect(cell(last, "9", "asked-once")).toEqual(["no grade ✗", `Jev request failed: ${NOT_RECORDED}`])
    expect(cell(last, "9", "asked-thrice")).toEqual(["no grade ✗", `Jev request failed: ${NOT_RECORDED}`])
    // With a key, the ninth case is sent to the gateway, and graded from what it answers.
    const gateway = fakeGateway({ otherwise: 0.9 })
    const keyed = await check(applied("your-own-case"), A_KEY, gateway.fetchFn)
    expect(gateway.sent.filter((one) => one.input.includes("spider")).map((one) => one.names.join(", "))).toEqual(["gives", "gives, false, commits"])
    expect(cell(keyed.last, "9", "asked-once")).toEqual(["yes ✓", "gives the reference answer: 0.9"])
  })

  test("a label changed (an experiment): case 4 wrong; asked-thrice agrees with 8 of 8, asked-once with 4, text with 1", async () => {
    const { check } = await page(applied("hedge-is-wrong"))
    const { last } = await check(applied("hedge-is-wrong"))
    expect(lines(last)).toEqual([
      "text: agrees with 1 of 8; false passes: 4, 5, 6, 7, 8; false fails: 2, 3",
      "asked-once: agrees with 4 of 8; false passes: 4, 5, 6, 7; false fails: none",
      "asked-thrice: agrees with 8 of 8; false passes: none; false fails: none",
    ])
  })

  test("a bar moved to fit (an experiment): commits at 0.25 passes case 4, and asked-thrice agrees with 8 of 8", async () => {
    const { check } = await page(applied("commit-lower"))
    const { last } = await check(applied("commit-lower"))
    expect(lines(last)).toEqual([TEXT, ONCE, "asked-thrice: agrees with 8 of 8; false passes: none; false fails: none"])
    expect(cell(last, "4", "asked-thrice")).toEqual(["yes ✓", "gives the reference answer: 0.93; says something false: 0.11; commits to one answer: 0.29"])
  })

  test("a stricter bar (an experiment): asked-once at 0.8 fails Lisboa., agrees with 4 of 8, and keeps its three false passes", async () => {
    const { check } = await page(applied("once-stricter"))
    const { last } = await check(applied("once-stricter"))
    expect(lines(last)).toEqual([TEXT, "asked-once: agrees with 4 of 8; false passes: 5, 6, 7; false fails: 3", THRICE])
    expect(cell(last, "3", "asked-once")).toEqual(["no ✗", "gives the reference answer: 0.7"])
  })

  test("the check and the chat take turns: refused while a turn runs, the page told while it runs, and the chat answers after it", async () => {
    const { runtime, check, say } = await page()
    expect(gradeTheGrader.chips).toEqual(["What is 2 + 3?", "What is the capital of Portugal?", "Where is the key?"])
    const replied = say("What is 2 + 3?")
    await new Promise<void>((resolve) => { const stop = runtime.onTrace((trace) => { if (trace._tag === "Event") { stop(); resolve() } }) })
    expect(runtime.busy).toBe(true)
    expect((await check()).ran).toEqual(Result.fail(TURN_RUNNING))
    expect(await replied).toBe("The tool answered: calculator says 5.")
    const running = check()
    expect(runtime.checking).toBe(true)
    expect((await check()).ran).toEqual(Result.fail("it is running already."))
    expect((await running).last?.status).toBe("Done: 24 of 24 checks graded.")
    expect(runtime.checking).toBe(false)
    expect(await say("What is 2 + 3?")).toBe("The tool answered: calculator says 5.")
  })

  test("Stop interrupts a check where it is: the request to Jev is aborted, the text grader keeps its checks, and the others say they were not checked", async () => {
    const { runtime, check } = await page()
    const signals: Array<AbortSignal> = []
    let stopping: Promise<void> | undefined
    // Stop as the button does, once the request is out: a press comes after the run has started, never inside it.
    const gateway = fakeGateway({ hold: (signal) => { signals.push(signal); setTimeout(() => { stopping = runtime.stopAlone() }, 0) } })
    const { ran, last } = await check(SOURCES, A_KEY, gateway.fetchFn)
    await stopping
    expect(Result.isSuccess(ran) && Exit.hasInterrupts(ran.success)).toBe(true)
    expect(last?.status).toBe("Stopped: 8 of 24 checks graded. A grader cut short says how many cases it checked.")
    expect(lines(last)).toEqual([TEXT, "asked-once: not checked yet", "asked-thrice: not checked yet"])
    expect(cell(last, "1", "asked-once")).toEqual(["not checked", ""])
    // One request was sent, and it was aborted.
    expect(gateway.sent).toHaveLength(1)
    expect(signals.map((signal) => signal.aborted)).toEqual([true])
    expect(runtime.checking).toBe(false)
  })

  test("a labels.ts that makes no list and a graders.ts that makes no graders are refused, by the build and by the button, in words that name the file", async () => {
    const { runtime, check } = await page()
    const noLabels = { ...SOURCES, labels: "export const labels = 42" }
    const labelsWords = "labels.ts did not run: labels is not a list of labelled answers. It should be an array, each entry { id, question, reference, answer, label }, with label true or false."
    expect(await runtime.start(noLabels)).toEqual({ _tag: "Refused", message: labelsWords })
    expect((await check(noLabels)).ran).toEqual(Result.fail(labelsWords))
    const noGraders = { ...SOURCES, graders: SOURCES.graders?.replace("export const graders = [", "export const graders = 42\nconst unused = [") ?? "" }
    const gradersWords = 'graders.ts did not run: graders is not a list of graders. It should be an array, each entry { id, version, kind, metrics, run }, kind "code" or "model".'
    expect(await runtime.start(noGraders)).toEqual({ _tag: "Refused", message: gradersWords })
    expect((await check(noGraders)).ran).toEqual(Result.fail(gradersWords))
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
  })

  test("what the package refuses itself, two graders of one id, ends the check in its words", async () => {
    const twice = { ...SOURCES, graders: SOURCES.graders?.replace('id: "asked-once",', 'id: "text",') ?? "" }
    const { check } = await page(twice)
    const { ran, last } = await check(twice)
    expect(Result.isSuccess(ran) && Exit.isSuccess(ran.success)).toBe(true)
    expect(last?.status).toBe('The check did not run to the end: Evaluation app refused (3 violations): duplicate-id at runnables.1.definition.id: runnable id "text.subject" is used more than once; duplicate-id at graders.1.definition.id: grader id "text.agreement" is used more than once; duplicate-id at projections.1.definition.id: projection id "text.agreement" is used more than once')
  })

  test("the lesson's files, experiments and buttons", () => {
    expect(gradeTheGrader.files.map((file) => [file.id, file.readOnly])).toEqual([["labels", false], ["graders", false], ["calibration", true], ["agent", true], ["tools", true], ["chat", true], ["memory", true]])
    expect(gradeTheGrader.mainFile).toBe("labels")
    expect(Object.entries(gradeTheGrader.experiments).map(([id, experiment]) => [id, experiment.file, (experiment.also ?? []).map((edit) => edit.file)])).toEqual([
      ["hedge-is-wrong", "labels", []], ["commit-lower", "graders", []], ["your-own-case", "labels", []], ["once-stricter", "graders", []],
    ])
    expect(gradeTheGrader.controls).toEqual({})
    expect(gradeTheGrader.kits).toBeUndefined()
    expect(gradeTheGrader.evals).toBeUndefined()
    // The lesson is not durable: a reload starts from the starter code and an empty conversation.
    expect(gradeTheGrader.durable).toBeUndefined()
  })
})
