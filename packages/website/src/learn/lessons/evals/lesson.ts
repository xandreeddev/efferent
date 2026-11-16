// Lesson 13, "Evals": a check says the agent did the right thing once; an
// eval runs it on many tasks, many times, and says how often, model by
// model. Lesson 12's program, read-only, and a new file the learner edits,
// evals.ts: the dataset written by hand, the graders and the suite's
// settings, in the eval package's own nouns. runnable.ts, read-only, binds
// the program as the runnable and runs the suite once for each candidate.
// "Run evals" runs it (`Lesson.evals`), taking turns with the chat as
// lesson 12's checks do. The eval package is loaded only when it is pressed,
// by `load`, so no other lesson's page carries it.
import { Effect, Option, Predicate, Result, Schema } from "effect"
import { DEFAULT_MEMORY, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsDocumentOf } from "../tools/tools.source.ts"
import { CHAT } from "../test-your-agent/chat.source.ts"
import { Chat } from "../../page-chat.ts"
import { madeOn } from "../test-your-agent/lesson.ts"
import { named, programOf, runStatements } from "../../evaluate.ts"
import type { Lesson, PageParts, Sources } from "../../lesson.ts"
import { DEFAULT_AGENT, documentOf as agentDocumentOf } from "./agent.source.ts"
import { DEFAULT_EVALS, EVALS_HEADER, EVALS_IMPORTS, evalsBodyOf, evalsDocumentOf } from "./evals.source.ts"
import { runnableDocumentOf } from "./runnable.source.ts"
import { baselineMisses, lenient, once, strictGate } from "./config-edit.ts"

/** What evals.ts imports. */
const evalsNames = { Effect, Option, Schema }

/** What evals.ts made, each held to the guard of its kind. */
export interface EvalsMade {
  readonly dataset: unknown
  readonly evaluators: ReadonlyArray<unknown>
  readonly repetitions: number
  readonly gates: ReadonlyArray<unknown>
  /** Each case's id, in order: the rows of the page's table. */
  readonly tasks: ReadonlyArray<string>
}

const NO_DATASET = "evals.ts did not run: dataset is not a dataset. It should be { id, version, input, reference, cases }, with input and reference schemas and cases a list."
const NO_EVALUATORS = "evals.ts did not run: evaluators is not a list of graders. It should be an array, each entry { id, version, metrics, run }."
const NO_REPETITIONS = "evals.ts did not run: repetitions is not a whole number of at least 1."
const NO_GATES = "evals.ts did not run: gates is not a list of gates. It should be an array, each entry { grader, metric, aggregate, mode, minimum, maximum, requiresReviewedReference }."

/** One case of the dataset: its id, or why it is no case, in words that name the file. */
const caseIdOf = (entry: unknown, index: number): Result.Result<string, string> => {
  const id = named(entry, "id")
  return typeof id === "string" && id !== "" && typeof named(entry, "family") === "string" && typeof named(entry, "provenance") === "string"
    ? Result.succeed(id)
    : Result.fail(`evals.ts did not run: case ${index + 1} of the dataset is not a case. It should be { id, family, split, review, input, reference, provenance }.`)
}

/** One grader of evals.ts: an `Evaluator`'s fields, each of its kind. */
const isEvaluator = (entry: unknown): boolean =>
  typeof named(entry, "id") === "string" && typeof named(entry, "version") === "string" && Array.isArray(named(entry, "metrics")) && Predicate.isFunction(named(entry, "run"))

/**
 * evals.ts run with the names it imports: what it made, or why it is not what runnable.ts needs, in words that name
 * the file. What the eval package checks itself (a case's split, a gate's grader, a reference that does not decode)
 * is left to it: a run refuses those in the package's words.
 */
export const evalsMade = (evals: string): Result.Result<EvalsMade, string> =>
  Result.flatMap(runStatements("evals.ts did not run: ", evalsBodyOf(evals), "{ dataset, evaluators, repetitions, gates }", evalsNames), (made) => {
    const dataset = named(made, "dataset")
    const cases = named(dataset, "cases")
    if (typeof named(dataset, "id") !== "string" || typeof named(dataset, "version") !== "string" || !Schema.isSchema(named(dataset, "input")) || !Schema.isSchema(named(dataset, "reference")) || !Array.isArray(cases)) return Result.fail(NO_DATASET)
    const entries: ReadonlyArray<unknown> = cases
    const evaluators = named(made, "evaluators")
    if (!Array.isArray(evaluators) || !evaluators.every(isEvaluator)) return Result.fail(NO_EVALUATORS)
    const repetitions = named(made, "repetitions")
    if (typeof repetitions !== "number" || !Number.isInteger(repetitions) || repetitions < 1) return Result.fail(NO_REPETITIONS)
    const gates = named(made, "gates")
    if (!Array.isArray(gates)) return Result.fail(NO_GATES)
    const listed: ReadonlyArray<unknown> = evaluators
    const bounds: ReadonlyArray<unknown> = gates
    return Result.map(Result.all(entries.map(caseIdOf)), (tasks) => ({ dataset, evaluators: listed, repetitions, gates: bounds, tasks }))
  })

/** The files the learner reads but does not edit, as the page runs them: agent.ts and memory.ts are lesson 12's. */
export const withReadOnly = (sources: Sources): Sources => ({ ...sources, agent: DEFAULT_AGENT, memory: DEFAULT_MEMORY })

/**
 * The files as the page runs them: `main`, ready to run, over the page's stand-ins and the page's chat, as lesson
 * 12's. evals.ts is run too, so one that makes no dataset refuses the build as any other file does; nothing of the
 * eval runs here, and the eval package is not loaded.
 */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(madeOn(withReadOnly(sources), { kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, Chat, chatOn: parts.chatOn, pane: parts.pane, model: parts.model }, parts.watchMemory), ({ main }) =>
    // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
    Result.flatMap(programOf(main), (program) => Result.map(evalsMade(sources.evals ?? ""), () => program)))

/** The chips: one message of each task, as the chat answers it. */
const CHIPS = ["What is 2 + 3?", "What is 12 * 3?", "The meeting is on Tuesday. When is the meeting?", "The keys are under the mat. Where are the keys?"]

export const evalsLesson: Lesson = {
  slug: "evals",
  files: [
    {
      id: "evals", label: "evals.ts", defaultText: DEFAULT_EVALS, documentOf: evalsDocumentOf, editableFrom: EVALS_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: EVALS_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    { id: "runnable", label: "runnable.ts", defaultText: "", documentOf: runnableDocumentOf, editableFrom: runnableDocumentOf().length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    { id: "agent", label: "agent.ts", defaultText: "", documentOf: () => agentDocumentOf(DEFAULT_AGENT), editableFrom: agentDocumentOf(DEFAULT_AGENT).length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    {
      id: "tools", label: "tools.ts", defaultText: DEFAULT_TOOLS, documentOf: toolsDocumentOf, editableFrom: TOOLS_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: TOOLS_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    { id: "chat", label: "chat.ts", defaultText: "", documentOf: () => CHAT, editableFrom: CHAT.length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    { id: "memory", label: "memory.ts", defaultText: "", documentOf: () => memoryDocumentOf(DEFAULT_MEMORY), editableFrom: memoryDocumentOf(DEFAULT_MEMORY).length, formatPrefix: "", sections: [], folded: [], readOnly: true },
  ],
  mainFile: "evals",
  chips: CHIPS,
  // Sent at once, one turn takes all three: Echo works out both sums, and answers with the tools' results.
  three: CHIPS.slice(0, 3),
  // No button of the page sends a fill: the type asks for one.
  fill: CHIPS,
  controls: {},
  experiments: {
    lenient: { file: "evals", apply: lenient.evals, also: [{ file: "tools", apply: lenient.tools }] },
    once: { file: "evals", apply: once },
    "strict-gate": { file: "evals", apply: strictGate },
    "baseline-misses": { file: "evals", apply: baselineMisses },
  },
  evaluate: evaluateLesson,
  // "Run evals": the part of the page that runs them, with the eval package, is loaded when it is pressed.
  evals: {
    start: (sources, changed) => (model) =>
      import("./run.ts").then(
        (part) => part.startEvals(sources, changed)(model),
        () => Result.fail("the part of the page that runs evals did not load. Reload the page and try again."),
      ),
  },
}

