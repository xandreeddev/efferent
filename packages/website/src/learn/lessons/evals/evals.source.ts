// Lesson 13's evals.ts: the eval in the package's own nouns. A dataset of
// tasks, each a message and a reference written by hand; the graders, each
// an `Evaluator` that reads what the program did beside the reference; how
// many times each task is run; and the gates the suite must pass. The
// learner edits all of it, as plain JavaScript the page runs as written.
// runnable.ts turns it into tasks and graders and runs it.
import { replaced } from "../base/agent.source.ts"

/** Read-only: where each name the file uses comes from. */
export const EVALS_IMPORTS = `import { Effect, Schema } from "effect"`

/** Everything before the editable part. */
export const EVALS_HEADER = `${EVALS_IMPORTS}\n\n`

/** The cases of the dataset, as the file starts: two that call a tool, and two answered from the message. */
const CASES = `    {
      id: "sum",
      // A family is a kind of task: these two call a tool, the other two answer from the message.
      family: "tool",
      split: "validation",
      // Someone read this reference and agrees with it. The gate below does not pass while any
      // of its trials' references is "provisional", one no one has reviewed yet.
      review: "reviewed",
      input: "What is 2 + 3?",
      reference: { call: { name: "calculator", input: { a: 2, op: "+", b: 3 } }, holds: "5" },
      provenance: "written by hand",
    },
    {
      id: "product",
      family: "tool",
      split: "validation",
      review: "reviewed",
      input: "What is 12 * 3?",
      reference: { call: { name: "calculator", input: { a: 12, op: "*", b: 3 } }, holds: "36" },
      provenance: "written by hand",
    },
    {
      id: "meeting",
      family: "text",
      split: "validation",
      review: "reviewed",
      input: "The meeting is on Tuesday. When is the meeting?",
      reference: { holds: "Tuesday" },
      provenance: "written by hand",
    },
    {
      id: "keys",
      family: "text",
      split: "validation",
      review: "reviewed",
      input: "The keys are under the mat. Where are the keys?",
      reference: { holds: "under the mat" },
      provenance: "written by hand",
    },
`

/** The end of the list of cases: an experiment that adds a task puts it before this. */
export const CASES_END = `  ],
}`

/** The grader of the answer, as the file starts: the answer holds the reference's text, and is no copy of the message. */
export const ANSWER_CHECK = `      const message = messageOf(turns)
      const repeats = message !== "" && answer.includes(message)
      const holds = answer.includes(reference.holds) && !repeats
      const reason = repeats
        ? "the answer repeats the message"
        : \`the answer \${holds ? "holds" : "does not hold"} "\${reference.holds}"\`
`

/** The gate, as the file starts: a blocking one, on the answer's grader, at 80 %. */
export const GATE = `  {
    grader: "answer@1",
    metric: "holds",
    minimum: 0.8,
  },
`

/** The number of repetitions, as the file starts. */
export const REPETITIONS = "export const repetitions = 5"

/** What the learner edits. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_EVALS = `// The golden set: the tasks your agent is measured on. Each is a message to send, and a reference
// written by hand: the text a right answer holds, and for a sum the call that works it out. The
// graders compare what the program did with the reference, never with what a model once said.
const Reference = Schema.Struct({
  call: Schema.optionalKey(Schema.Struct({ name: Schema.String, input: Schema.Json })),
  holds: Schema.String,
})

export const dataset = {
  id: "lesson",
  version: "1",
  // A task's input is the message sent. Its reference is for the graders alone: the program
  // never sees it.
  input: Schema.String,
  reference: Reference,
  cases: [
${CASES}${CASES_END}

// What the turns a trial left say: the answer, the message sent, and every call made. A trial
// sends one message, so it leaves one turn.
const answerOf = (turns) => turns.at(-1)?.answer ?? ""
const messageOf = (turns) => turns.at(0)?.messages.at(0) ?? ""
const callsOf = (turns) => turns.flatMap((turn) => turn.steps.flatMap((step) => step.calls))
const listed = (calls) => (calls.length === 0 ? "no tool" : calls.join(", "))

// The graders. Each is code: it reads the turns and the task's reference, and says yes or no,
// with the reason in words.
export const evaluators = [
  // The answer holds the reference's text, and is no copy of the message: a model that repeats
  // the question has not answered it, even when the question holds the answer.
  {
    id: "answer",
    version: "1",
    metrics: ["holds"],
    run: ({ turns, reference }) => {
      const answer = answerOf(turns)
${ANSWER_CHECK}      return Effect.succeed({ metrics: [{ kind: "boolean", name: "holds", value: holds }], reason })
    },
  },
  // The right tool with the right numbers: the one call the reference names, its input written
  // the same way. A task whose reference names no call passes when none was made.
  {
    id: "tool",
    version: "1",
    metrics: ["called"],
    run: ({ turns, reference }) => {
      const made = callsOf(turns).map((call) => \`\${call.name}(\${JSON.stringify(call.input)})\`)
      const call = reference.call
      const wanted = call === undefined ? [] : [\`\${call.name}(\${JSON.stringify(call.input)})\`]
      const called = listed(made) === listed(wanted)
      const reason = called
        ? \`it called \${listed(made)}\`
        : \`it called \${listed(made)}, not \${listed(wanted)}\`
      return Effect.succeed({
        metrics: [{ kind: "boolean", name: "called", value: called }],
        reason,
      })
    },
  },
]

// How many times each task is run for each candidate. A model does not answer the same way
// every time, so one run of a task says little.
${REPETITIONS}

// The gates: what a candidate must reach. This one asks that at least 80 % of a candidate's
// trials have an answer that holds the reference. A gate names a grader, its metric, and a
// minimum, a maximum or both; runnable.ts passes each to the package's gate, which fills in the
// rest: it counts the share of trials that passed, it is blocking (it fails the suite), and it
// does not pass while any of its trials' references is provisional. mode: "diagnostic" makes
// one that is reported and fails nothing.
export const gates = [
${GATE}]`

/** The whole file as the learner reads it. */
export const evalsDocumentOf = (evals: string): string => `${EVALS_HEADER}${evals}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const evalsBodyOf = (evals: string): string => evals.replace(/^export /gm, "")

/**
 * The lines of evals.ts that take a type in the module a test compiles, as `[from, to]`: the dataset is a
 * `Dataset`, the graders are `Evaluator`s over what runnable.ts's projection hands them (`Graded`), the gates are a
 * suite's, and the three functions read the turns as that projection holds them. program.test.ts fails when the
 * starter text no longer holds one of them.
 */
export const TYPED: ReadonlyArray<readonly [string, string]> = [
  ["export const dataset = {", "export const dataset: Dataset<string, typeof Reference.Type> = {"],
  ["const answerOf = (turns) =>", 'const answerOf = (turns: Graded["turns"]) =>'],
  ["const messageOf = (turns) =>", 'const messageOf = (turns: Graded["turns"]) =>'],
  ["const callsOf = (turns) =>", 'const callsOf = (turns: Graded["turns"]) =>'],
  ["const listed = (calls) =>", "const listed = (calls: ReadonlyArray<string>) =>"],
  ["export const evaluators = [", "export const evaluators: ReadonlyArray<Evaluator<Graded>> = ["],
  ["export const gates = [", "export const gates: ReadonlyArray<GateOptions> = ["],
]

/** The same file as a module a test can compile: its imports, the types it is held to, and the text typed. */
export const evalsModuleOf = (evals: string): string => `${EVALS_IMPORTS}
import type { Dataset, Evaluator, GateOptions } from "@xandreed/evals"
import type { Graded } from "./runnable.ts"

${replaced(evals, TYPED)}
`
