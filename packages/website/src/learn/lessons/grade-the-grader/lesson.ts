// Lesson 19, "Grade the grader": a grader is code that can be wrong too.
// People write labels, and each grader is checked against them before its
// numbers are trusted. Two files the learner edits: labels.ts (answers a
// person labelled right or wrong) and graders.ts (lesson 13's text rule and
// two model graders that ask Jev, a decision model). calibration.ts,
// read-only, checks each grader against the labels with the eval package's
// calibration. agent.ts and the files it imports are lesson 13's, read-only:
// a lesson has a program, so the chat answers as lesson 13's does. "Check
// the graders" runs the check (`Lesson.calibration`), taking turns with the
// chat as lesson 13's evals do. The eval package is loaded only when it is
// pressed, so no other lesson's page carries it.
import { Effect, Predicate, Result } from "effect"
import { named, programOf, runStatements } from "../../evaluate.ts"
import type { Lesson, PageParts, Sources } from "../../lesson.ts"
import { gatewayKey } from "../../models/gateway-key.ts"
import { Chat } from "../../page-chat.ts"
import { madeOn } from "../test-your-agent/lesson.ts"
import { CHAT } from "../test-your-agent/chat.source.ts"
import { DEFAULT_MEMORY, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsDocumentOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, documentOf as agentDocumentOf } from "./agent.source.ts"
import type { Labelled } from "./board.ts"
import { calibrationDocumentOf } from "./calibration.source.ts"
import { commitLower, hedgeIsWrong, onceStricter, yourOwnCase } from "./config-edit.ts"
import { DEFAULT_GRADERS, GRADERS_HEADER, GRADERS_IMPORTS, gradersBodyOf, gradersDocumentOf } from "./graders.source.ts"
import { DEFAULT_LABELS, labelsBodyOf, labelsDocumentOf } from "./labels.source.ts"

const NO_LABELS = "labels.ts did not run: labels is not a list of labelled answers. It should be an array, each entry { id, question, reference, answer, label }, with label true or false."
const NO_GRADERS = 'graders.ts did not run: graders is not a list of graders. It should be an array, each entry { id, version, kind, metrics, run }, kind "code" or "model".'

/** What labels.ts made: each entry as the file made it, and as the table's row heads it. */
export interface LabelsMade {
  readonly labels: ReadonlyArray<unknown>
  readonly cases: ReadonlyArray<Labelled>
}

/** One entry of labels.ts: a labelled answer, or why it is none, in words that name the file. */
const labelledOf = (entry: unknown, index: number): Result.Result<Labelled, string> => {
  const id = named(entry, "id")
  const question = named(entry, "question")
  const answer = named(entry, "answer")
  const label = named(entry, "label")
  return typeof id === "string" && id !== "" && typeof question === "string" && typeof named(entry, "reference") === "string" && typeof answer === "string" && typeof label === "boolean"
    ? Result.succeed({ id, question, answer, label })
    : Result.fail(`labels.ts did not run: entry ${index + 1} of labels is not a labelled answer. It should be { id, question, reference, answer, label }, with id, question, reference and answer text, and label true or false.`)
}

/** labels.ts run as the page runs it: its list, or why it is not one, in words that name the file. It imports nothing. */
export const labelsMade = (labels: string): Result.Result<LabelsMade, string> =>
  Result.flatMap(runStatements("labels.ts did not run: ", labelsBodyOf(labels), "labels", {}), (made) => {
    if (!Array.isArray(made)) return Result.fail(NO_LABELS)
    const entries: ReadonlyArray<unknown> = made
    return Result.map(Result.all(entries.map(labelledOf)), (cases) => ({ labels: entries, cases }))
  })

/** One grader of graders.ts: an `Evaluator`'s fields, each of its kind. */
const isEvaluator = (entry: unknown): boolean =>
  typeof named(entry, "id") === "string" && typeof named(entry, "version") === "string" && (named(entry, "kind") === "code" || named(entry, "kind") === "model") &&
  Array.isArray(named(entry, "metrics")) && Predicate.isFunction(named(entry, "run"))

/** What graders.ts made: the list, and each grader's id, the table's columns. */
export interface GradersMade {
  readonly graders: ReadonlyArray<unknown>
  readonly ids: ReadonlyArray<string>
}

/**
 * graders.ts run with `names`, what it imports: its list of graders, or why it is not one, in words that name the
 * file. What the eval package checks itself (two graders of one id, a metric a grader does not declare) it refuses
 * when the graders are checked, in its words.
 */
export const gradersMade = (graders: string, names: Record<string, unknown>): Result.Result<GradersMade, string> =>
  Result.flatMap(runStatements("graders.ts did not run: ", gradersBodyOf(graders), "graders", names), (made) => {
    if (!Array.isArray(made) || !made.every(isEvaluator)) return Result.fail(NO_GRADERS)
    const listed: ReadonlyArray<unknown> = made
    return Result.succeed({ graders: listed, ids: listed.map((entry) => String(named(entry, "id"))) })
  })

/**
 * What graders.ts is handed when the program is built. `SemanticJudge` comes from the eval package, which the page
 * loads only when "Check the graders" is pressed: the build runs the file to check what it makes, and a grader reads
 * `SemanticJudge` only when it runs. The press runs the file again, with the package's own `SemanticJudge`.
 */
/** Why `SemanticJudge` cannot be read when the program is built, in words that name the file. */
export const JUDGE_AT_BUILD =
  "SemanticJudge is given when Check the graders is pressed, not when the program is built: read it inside a grader's run, as the starter does."

/**
 * The build's `SemanticJudge`: any use of it at the top of graders.ts says why in words, where a value of nothing
 * would fail in the browser's own words. A grader's run, which reads the judge, is not run by the build.
 */
const judgeAtBuild: object = new Proxy({}, {
  get: () => { throw new Error(JUDGE_AT_BUILD) },
  has: () => { throw new Error(JUDGE_AT_BUILD) },
})

const buildNames = { Effect, SemanticJudge: judgeAtBuild }

/** The files the learner reads but does not edit, as the page runs them: lesson 13's agent.ts, tools.ts and memory.ts. */
export const withReadOnly = (sources: Sources): Sources => ({ ...sources, agent: DEFAULT_AGENT, tools: DEFAULT_TOOLS, memory: DEFAULT_MEMORY })

/**
 * The files as the page runs them: `main`, ready to run, over the page's stand-ins and the page's chat, as lesson
 * 13's. labels.ts and graders.ts are run too, so one that makes no list refuses the build as any other file does;
 * nothing of the check runs here, and the eval package is not loaded.
 */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(madeOn(withReadOnly(sources), { kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, Chat, chatOn: parts.chatOn, pane: parts.pane, model: parts.model }, parts.watchMemory), ({ main }) =>
    // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
    Result.flatMap(programOf(main), (program) =>
      Result.flatMap(labelsMade(sources.labels ?? ""), () => Result.map(gradersMade(sources.graders ?? "", buildNames), () => program))))

/** The chips: the questions of the labelled answers, each once, as the chat answers them. */
const CHIPS = ["What is 2 + 3?", "What is the capital of Portugal?", "Where is the key?"]

export const gradeTheGrader: Lesson = {
  slug: "grade-the-grader",
  files: [
    { id: "labels", label: "labels.ts", defaultText: DEFAULT_LABELS, documentOf: labelsDocumentOf, editableFrom: 0, formatPrefix: "", sections: [], folded: [], readOnly: false },
    {
      id: "graders", label: "graders.ts", defaultText: DEFAULT_GRADERS, documentOf: gradersDocumentOf, editableFrom: GRADERS_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: GRADERS_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    { id: "calibration", label: "calibration.ts", defaultText: "", documentOf: calibrationDocumentOf, editableFrom: calibrationDocumentOf().length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    { id: "agent", label: "agent.ts", defaultText: "", documentOf: () => agentDocumentOf(DEFAULT_AGENT), editableFrom: agentDocumentOf(DEFAULT_AGENT).length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    { id: "tools", label: "tools.ts", defaultText: "", documentOf: () => toolsDocumentOf(DEFAULT_TOOLS), editableFrom: toolsDocumentOf(DEFAULT_TOOLS).length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    { id: "chat", label: "chat.ts", defaultText: "", documentOf: () => CHAT, editableFrom: CHAT.length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    { id: "memory", label: "memory.ts", defaultText: "", documentOf: () => memoryDocumentOf(DEFAULT_MEMORY), editableFrom: memoryDocumentOf(DEFAULT_MEMORY).length, formatPrefix: "", sections: [], folded: [], readOnly: true },
  ],
  mainFile: "labels",
  chips: CHIPS,
  three: CHIPS,
  // No button of the page sends a fill: the type asks for one.
  fill: CHIPS,
  controls: {},
  experiments: {
    "hedge-is-wrong": { file: "labels", apply: hedgeIsWrong },
    "commit-lower": { file: "graders", apply: commitLower },
    "your-own-case": { file: "labels", apply: yourOwnCase },
    "once-stricter": { file: "graders", apply: onceStricter },
  },
  evaluate: evaluateLesson,
  // "Check the graders": the part of the page that checks them, with the eval package, is loaded when it is pressed.
  // The judge is picked then: the real Jev with an AI Gateway key kept, the stand-in without one.
  calibration: {
    start: (sources, changed) => (model) =>
      import("./run.ts").then(
        (part) => part.startCheck(sources, changed, gatewayKey)(model),
        () => Result.fail("the part of the page that checks the graders did not load. Reload the page and try again."),
      ),
  },
}
