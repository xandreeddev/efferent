// Lesson 19's files, compiled as written, type-checked, and run in Node:
// agent.ts is lesson 13's as it is; what the page runs of calibration.ts is
// the shown text with its types taken out, by named pieces; graders.ts
// compiles with each grader held to the eval package's `Evaluator`, as shown
// and as each experiment leaves it, and without the judge it does not; and
// the check, run with the package's calibration on the stand-in, gives the
// numbers the page states, and the same through the real path (the page's
// `decide` over a fake gateway), sixteen requests and no more.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Effect, Option, Schema } from "effect"
import { EvaluationRun } from "@xandreed/evals"
import type { SemanticJevOptions, Trial } from "@xandreed/evals"
import { formatRegion } from "../../format.ts"
import { applyExperiment } from "../../lesson.ts"
import { gatewayDecider } from "../../models/decide.ts"
import type { Fetch } from "../../models/gateway.ts"
import { DEFAULT_AGENT as LESSON_13_AGENT } from "../evals/agent.source.ts"
import { CHAT } from "../test-your-agent/chat.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, moduleOf } from "./agent.source.ts"
import { CALIBRATION, CALIBRATION_IMPORTS, calibrationBodyOf, calibrationModuleOf, PAGE_GIVES, TYPES } from "./calibration.source.ts"
import { HEDGE_WRONG, OWN_CASE } from "./config-edit.ts"
import { COMMITS_BAR, DEFAULT_GRADERS, GRADERS_IMPORTS, gradersBodyOf, gradersDocumentOf, gradersModuleOf, ONCE_BAR, TYPED } from "./graders.source.ts"
import { jevTransport } from "./jev.ts"
import { DEFAULT_LABELS, HEDGE_LABEL, LABELS_END, labelsBodyOf, labelsModuleOf } from "./labels.source.ts"
import { gradeTheGrader } from "./lesson.ts"
import { recordedAnswers, standIn } from "./stand-in.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

/** The files a learner edits, as the lesson starts or as an experiment leaves them. */
interface Files {
  readonly labels?: string
  readonly graders?: string
}

const write = (name: string, files: Files = {}, calibration: string = CALIBRATION) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(DEFAULT_AGENT))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(DEFAULT_TOOLS))
  writeFileSync(new URL("./labels.ts", at), labelsModuleOf(files.labels ?? DEFAULT_LABELS))
  writeFileSync(new URL("./graders.ts", at), gradersModuleOf(files.graders ?? DEFAULT_GRADERS))
  writeFileSync(new URL("./calibration.ts", at), calibrationModuleOf(calibration))
  return at
}

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const STARTERS: Record<string, string> = Object.fromEntries(gradeTheGrader.files.map((file) => [file.id, file.defaultText]))

/** The files as an experiment leaves them: every file it edits, all of them or none. */
const applied = (id: string): Files => {
  const experiment = Option.fromNullishOr(gradeTheGrader.experiments[id])
  return Object.fromEntries(Option.getOrThrow(Option.flatMap(experiment, (one) => applyExperiment(one, (file) => STARTERS[file] ?? ""))))
}

/** The lines of `after` that `before` has not, and the lines of `before` that `after` has not. */
const changed = (before: string, after: string) => ({
  gone: before.split("\n").filter((line) => !after.split("\n").includes(line)),
  come: after.split("\n").filter((line) => !before.split("\n").includes(line)),
})

/** How many times `piece` is in `text`. */
const times = (text: string, piece: string): number => text.split(piece).length - 1

type Run = (evaluate: SemanticJevOptions["evaluate"], hear: (trial: Trial) => void) => Effect.Effect<unknown, unknown>

/**
 * Run the check of the files written at `at`, with `evaluate` answering for Jev: per grader, how many of its checks
 * agree with their label, its false passes, its false fails and the cases it gave no grade, each read from the
 * package's agreement grade and the grader's observed status; and every check written.
 */
const checked = async (at: URL, evaluate: SemanticJevOptions["evaluate"]) => {
  const { run }: { readonly run: Run } = await import(new URL("./calibration.ts", at).href)
  const heard: Array<Trial> = []
  const runs = await Effect.runPromise(Effect.flatMap(run(evaluate, (trial) => { heard.push(trial) }), Schema.decodeUnknownEffect(Schema.Array(Schema.toType(EvaluationRun)))))
  const said = (trial: Trial, name: string) => trial.grades.some((grade) => grade.metrics.some((metric) => metric.name === name && metric.value === true))
  return {
    heard,
    runs,
    graders: runs.map((one) => {
      const trials = one.trials
      const ids = (keep: (trial: Trial) => boolean): ReadonlyArray<string> => trials.filter(keep).map((trial) => trial.task.id)
      return {
        grader: String(one.trials[0]?.suiteId ?? ""),
        agrees: `${trials.filter((trial) => said(trial, "agreement")).length} of ${trials.length}`,
        falsePasses: ids((trial) => said(trial, "false-pass")),
        falseFails: ids((trial) => said(trial, "false-fail")),
        noGrade: ids((trial) => JSON.stringify(Option.getOrNull(trial.output)).includes('"status":"error"')),
      }
    }),
  }
}

/** The starter's numbers: text 2 of 8, asked-once 5 of 8, asked-thrice 7 of 8. */
const STARTER = [
  { grader: "text", agrees: "2 of 8", falsePasses: ["5", "6", "7", "8"], falseFails: ["2", "3"], noGrade: [] },
  { grader: "asked-once", agrees: "5 of 8", falsePasses: ["5", "6", "7"], falseFails: [], noGrade: [] },
  { grader: "asked-thrice", agrees: "7 of 8", falsePasses: [], falseFails: ["4"], noGrade: [] },
]

/**
 * A fake of the gateway's `/v1/decisions`, shaped like its reply: each predicate answered from the stand-in's
 * recorded answers to the same request, or the request answered with a refusal of every question it does not hold.
 */
const fakeGateway = () => {
  const sent: Array<{ readonly input: string; readonly questions: ReadonlyArray<{ readonly type: string; readonly name: string; readonly instructions: string }> }> = []
  const Body = Schema.fromJsonString(Schema.Struct({ model: Schema.String, input: Schema.String, questions: Schema.Array(Schema.Struct({ type: Schema.String, name: Schema.String, instructions: Schema.String })) }))
  const fetchFn: Fetch = (_url, init) => {
    const body = Schema.decodeUnknownSync(Body)(init.body)
    sent.push({ input: body.input, questions: body.questions })
    const recorded = recordedAnswers({ state: body.input, questions: Object.fromEntries(body.questions.map((question) => [question.name, { type: "boolean", instructions: question.instructions }])) })
    const answers = body.questions.map((question) => Option.match(Option.flatMap(recorded, (found) => Option.fromNullishOr(found[question.name])), {
      onNone: () => ({ type: "refusal", name: question.name }),
      onSome: (probability) => ({ type: "predicate", name: question.name, probability }),
    }))
    return Promise.resolve(new Response(JSON.stringify({ answers, model: body.model, usage: { input_tokens: 90, output_tokens: 0, total_tokens: 90 } }), { status: 200 }))
  }
  return { fetchFn, sent }
}

describe("lesson 19's displayed program", () => {
  test("agent.ts is lesson 13's, as it is, and the read-only files the page shows are these texts", () => {
    expect(DEFAULT_AGENT).toBe(LESSON_13_AGENT)
    expect(STARTERS.labels).toBe(DEFAULT_LABELS)
    expect(STARTERS.graders).toBe(DEFAULT_GRADERS)
    const shown = Object.fromEntries(gradeTheGrader.files.filter((file) => file.readOnly).map((file) => [file.id, file.documentOf("")]))
    expect(Object.keys(shown)).toEqual(["calibration", "agent", "tools", "chat", "memory"])
    expect(shown.calibration).toBe(CALIBRATION)
    expect(shown.chat).toBe(CHAT)
  })

  test("calibration.ts as the page runs it is the shown text with its imports and its types taken out, and nothing else", () => {
    for (const [from] of TYPES) expect({ from, held: times(CALIBRATION, from) }).toEqual({ from, held: 1 })
    const body = calibrationBodyOf(CALIBRATION)
    expect(changed(CALIBRATION, body)).toEqual({
      gone: [
        ...CALIBRATION_IMPORTS.trimEnd().split("\n"),
        "export const Case = Schema.Struct({",
        "export type Case = typeof Case.Type",
        "const labelled = (one: (typeof labels)[number]): DatasetCase<Case, CalibrationReference> => ({",
        "export const rowOf = (trial: Trial) => {",
        "  const said = (name: string) =>",
        "export const checked = Effect.gen(function* () {",
      ],
      come: [
        "const Case = Schema.Struct({",
        "const labelled = (one) => ({",
        "const rowOf = (trial) => {",
        "  const said = (name) =>",
        "const checked = Effect.gen(function* () {",
      ],
    })
    // What is left names no type: no annotation, no type argument, no import.
    expect(body).not.toMatch(/\bimport\b|: (?:string|number|Trial|unknown)\b|<Case\b|DatasetCase|SemanticJevOptions|CalibrationReference/)
    // The names the page gives and no import names are said in a comment, where the typed module takes them.
    expect(times(CALIBRATION, PAGE_GIVES)).toBe(1)
    // No cast in the text a learner reads, and no comment line over 100 columns.
    expect(CALIBRATION).not.toMatch(/\bas (?:never|any|unknown|const)\b/)
    expect(CALIBRATION.split("\n").filter((line) => line.trimStart().startsWith("//") && line.length > 100)).toEqual([])
  })

  test("labels.ts and graders.ts: plain JavaScript as the page runs it, as Format leaves it, and the pieces their typed modules and experiments name", async () => {
    expect(GRADERS_IMPORTS).toBe('import { Effect } from "effect"\nimport { SemanticJudge } from "@xandreed/evals"')
    expect(gradersDocumentOf(DEFAULT_GRADERS)).toBe(`${GRADERS_IMPORTS}\n\n${DEFAULT_GRADERS}\n`)
    for (const [from] of TYPED) expect({ from, held: times(DEFAULT_GRADERS, from) }).toEqual({ from, held: 1 })
    for (const piece of [ONCE_BAR, COMMITS_BAR]) expect({ piece, held: times(DEFAULT_GRADERS, piece) }).toEqual({ piece, held: 1 })
    expect(times(DEFAULT_LABELS, HEDGE_LABEL)).toBe(1)
    expect(DEFAULT_LABELS.endsWith(LABELS_END)).toBe(true)
    // labels.ts compiles as it is shown: its typed module is the text.
    expect(labelsModuleOf(DEFAULT_LABELS)).toBe(`${DEFAULT_LABELS}\n`)
    // Plain JavaScript as written: the page runs it so. No cast, and no type written out.
    for (const body of [labelsBodyOf(DEFAULT_LABELS), gradersBodyOf(DEFAULT_GRADERS)]) {
      expect(body).not.toMatch(/\bas (?:never|any|unknown|const)\b|: (?:string|number|boolean|unknown|ReadonlyArray)\b|<[A-Z]/)
    }
    for (const text of [DEFAULT_LABELS, DEFAULT_GRADERS]) {
      expect(await formatRegion(text, "")).toEqual({ ok: true, text })
      expect(text.split("\n").filter((line) => line.trimStart().startsWith("//") && line.length > 100)).toEqual([])
    }
    // The eight cases, each with a label a person wrote, and a comment that says so.
    expect(times(DEFAULT_LABELS, "// A person wrote this label: ")).toBe(8)
    expect(times(DEFAULT_LABELS, "label: true,")).toBe(4)
    expect(times(DEFAULT_LABELS, "label: false,")).toBe(4)
  })

  test("each experiment changes the pieces it names, and no other; one applied twice, or over a text that lost its piece, changes nothing", async () => {
    expect(applied("hedge-is-wrong").labels).toBe(DEFAULT_LABELS.replace(HEDGE_LABEL, HEDGE_WRONG))
    expect(HEDGE_WRONG).toContain("label: false,")
    expect(changed(DEFAULT_GRADERS, applied("commit-lower").graders ?? "")).toEqual({ gone: [COMMITS_BAR], come: ["const THRICE_COMMITS = 0.25"] })
    expect(changed(DEFAULT_GRADERS, applied("once-stricter").graders ?? "")).toEqual({ gone: [ONCE_BAR], come: ["const ONCE_GIVES = 0.8"] })
    expect(applied("your-own-case").labels).toBe(`${DEFAULT_LABELS.slice(0, -1)}${OWN_CASE}]`)
    for (const [id, experiment] of Object.entries(gradeTheGrader.experiments)) {
      const once = applied(id)
      const text = once[experiment.file === "labels" ? "labels" : "graders"] ?? ""
      expect({ id, again: experiment.apply(text) }).toEqual({ id, again: Option.none() })
      expect({ id, rewritten: experiment.apply("const labels = 1") }).toEqual({ id, rewritten: Option.none() })
      // Every text an experiment leaves is as Format leaves it, and no line of a comment is longer than 100 columns.
      expect({ id, formatted: await formatRegion(text, "") }).toEqual({ id, formatted: { ok: true, text } })
      expect(text.split("\n").filter((line) => line.trimStart().startsWith("//") && line.length > 100)).toEqual([])
    }
  })

  test("the check on the stand-in: text agrees with 2 of 8, asked-once with 5, asked-thrice with 7, with the false passes and fails the page names", async () => {
    const run = await checked(write("stand-in"), standIn)
    expect(run.graders).toEqual(STARTER)
    // Three graders, eight cases: twenty-four checks, each written as it starts, as it ends, and once it is graded.
    expect(run.runs.map((one) => one.trials.length)).toEqual([8, 8, 8])
    expect(run.heard).toHaveLength(72)
    // The calibration's own gates: full agreement, no false pass and no false fail. No grader passes all three.
    expect(run.runs.map((one) => one.gates.map((gate) => [gate.metric, gate.passed]))).toEqual([
      [["agreement", false], ["false-pass", false], ["false-fail", false]],
      [["agreement", false], ["false-pass", false], ["false-fail", true]],
      [["agreement", false], ["false-pass", true], ["false-fail", false]],
    ])
  }, 60_000)

  test("each experiment's numbers on the stand-in", async () => {
    const numbers = async (id: string) => (await checked(write(id, applied(id)), standIn)).graders.map((one) => [one.grader, one.agrees, one.falsePasses, one.falseFails, one.noGrade])
    expect(await numbers("hedge-is-wrong")).toEqual([
      ["text", "1 of 8", ["4", "5", "6", "7", "8"], ["2", "3"], []],
      ["asked-once", "4 of 8", ["4", "5", "6", "7"], [], []],
      ["asked-thrice", "8 of 8", [], [], []],
    ])
    expect(await numbers("commit-lower")).toEqual([
      ["text", "2 of 8", ["5", "6", "7", "8"], ["2", "3"], []],
      ["asked-once", "5 of 8", ["5", "6", "7"], [], []],
      ["asked-thrice", "8 of 8", [], [], []],
    ])
    expect(await numbers("once-stricter")).toEqual([
      ["text", "2 of 8", ["5", "6", "7", "8"], ["2", "3"], []],
      ["asked-once", "4 of 8", ["5", "6", "7"], ["3"], []],
      ["asked-thrice", "7 of 8", [], ["4"], []],
    ])
    // A case Jev was never asked: the stand-in refuses it, the model graders give no grade, and the package counts a disagreement.
    expect(await numbers("your-own-case")).toEqual([
      ["text", "2 of 9", ["5", "6", "7", "8"], ["2", "3", "9"], []],
      ["asked-once", "5 of 9", ["5", "6", "7"], [], ["9"]],
      ["asked-thrice", "7 of 9", [], ["4"], ["9"]],
    ])
  }, 120_000)

  test("the real path, over a fake gateway: the page's decide behind the package's judge gives the same numbers, in sixteen requests", async () => {
    const gateway = fakeGateway()
    const run = await checked(write("gateway"), jevTransport(gatewayDecider(() => Option.some("k"), "typesafe-ai/jev", gateway.fetchFn)))
    expect(run.graders).toEqual(STARTER)
    // Eight requests of one predicate (asked-once), then eight of three, in their order (asked-thrice).
    expect(gateway.sent).toHaveLength(16)
    expect(gateway.sent.map((one) => one.questions.map((question) => `${question.type} ${question.name}`).join(", "))).toEqual([
      ...Array.from({ length: 8 }, () => "predicate gives"),
      ...Array.from({ length: 8 }, () => "predicate gives, predicate false, predicate commits"),
    ])
    expect(gateway.sent[0]?.input).toBe("Question: What is 2 + 3?\nReference answer: 5\nAgent's answer: 2 + 3 = 5.")
  }, 60_000)

  test("type-checks as TypeScript, all seven files, as shown and as each experiment leaves them; without the judge, the graders do not compile", () => {
    write("typed")
    for (const id of Object.keys(gradeTheGrader.experiments)) write(`typed-${id}`, applied(id))
    // calibration.ts with the judge's layer taken away: the model graders ask for SemanticJudge, and nothing gives it.
    const noJudge = CALIBRATION.replace("        judge,\n      ),", "        Layer.empty,\n      ),")
    expect(noJudge).not.toBe(CALIBRATION)
    write("type-level-no-judge", {}, noJudge)
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const result = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    const errors = output.split("\n").filter((line) => /error TS\d+/.test(line))
    // Every error is the one without the judge, and it names the service.
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.filter((line) => !line.includes("type-level-no-judge/calibration.ts"))).toEqual([])
    expect(output).toContain("SemanticJudge")
  }, 120_000)
})
