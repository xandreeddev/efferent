// Lesson 12's checks.ts: the few lines that run the program for a check, a
// function that makes one check, and the lesson's checks as a list. A check
// runs the program agent.ts exports over a stack of its own: the same
// modules, a model that follows a script, and a chat that is a list of
// messages. What the program did is read from the journal with the kernel's
// `turnsOf`. The learner edits all of it; the page runs it as written, and
// program.test.ts compiles and runs it.
import { replaced } from "../base/agent.source.ts"

/** Read-only: where each name the checks use comes from. */
export const CHECKS_IMPORTS = `import { Effect, Fiber, Option, Queue } from "effect"
import { ConformanceFailure, kernel, Sessions } from "@xandreed/core"
import { inProcessJournal, scriptedModel, sessions, turnsOf } from "@xandreed/sdk"
import { program } from "./agent.ts"
import { Chat, chatOn } from "./chat.ts"
import { flatMemory } from "./memory.ts"
import { toolsLive } from "./tools.ts"`

/** Everything before the editable part. */
export const CHECKS_HEADER = `${CHECKS_IMPORTS}\n\n`

/** The last lines of the list of checks, as the file starts and as each experiment leaves it: where an experiment adds a check. */
export const LIST_END = "  ),\n]"

/** The list's comment and its first line: an experiment that adds a function puts it above them. */
export const LIST_INTRO = `// The checks. Each has an id, a name, the script the model follows, the messages sent, and what
// must hold of the turns the program left.
export const checks = [
`

/**
 * The function that runs the program for a check, with its comment: the first lines of checks.ts. Lesson 13's
 * runnable.ts runs a trial with the same lines, derived from these by named pieces.
 */
export const TURNS_AFTER = `// Run the program for a check. It is the program main runs, over a stack of the check's own: the
// same modules, the model the check gives, and a chat that is a list. Each message is sent once
// the one before it is answered, so each is a turn of its own. What comes back is the journal the
// program left, read as its turns.
const turnsAfter = (model, messages) =>
  Effect.gen(function* () {
    const replies = yield* Queue.unbounded()
    let send = () => {}
    // A pane with no screen: Send is a function the check calls, and an answer or a failure goes
    // onto a queue the check waits on.
    const pane = {
      onSend: (given) => {
        send = given
      },
      appendToAnswer: () => {},
      finishAnswer: (text) => Queue.offerUnsafe(replies, text),
      showError: (error) => Queue.offerUnsafe(replies, String(error)),
      showStatus: () => {},
    }
    return yield* Effect.gen(function* () {
      const chat = yield* Chat
      const all = yield* Sessions
      const running = yield* Effect.forkScoped(program)
      for (const message of messages) {
        send(message)
        // The program never ends on its own. If it stopped, the check stops too, with the reason.
        yield* Effect.raceFirst(Queue.take(replies), Fiber.join(running))
      }
      yield* Fiber.interrupt(running)
      const journal = yield* all.read(chat.session)
      return turnsOf(journal.events)
    }).pipe(
      Effect.scoped,
      Effect.provide(toolsLive), // what each tool does when it is called
      Effect.provide(flatMemory), // what of the journal the model sees
      Effect.provide(chatOn(pane)), // the chat: a list of messages, where the page has a pane
      Effect.provide(sessions()), // conversations and their turns
      Effect.provide(inProcessJournal()), // a journal of the check's own, kept in the page
      Effect.provide(kernel()), // events every module can hook
      Effect.provide(model), // a model that follows a script, or the model you picked
    )
  })`

/** What the learner edits. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_CHECKS = `${TURNS_AFTER}

// One check. The program runs on a script, and holds reads the turns it left: it returns what is
// wrong, in words, or nothing. What is wrong is the check's failure.
const check = (id, name, script, messages, holds) => ({
  id,
  name,
  run: Effect.gen(function* () {
    const scripted = yield* scriptedModel(script)
    // A stack that does not run is no finding of the check: it stops the check, with the reason.
    const turns = yield* Effect.orDie(turnsAfter(scripted.model, messages))
    const wrong = holds(turns)
    if (wrong !== undefined)
      yield* Effect.fail(new ConformanceFailure({ check: id, message: wrong }))
  }),
})

// Every call the model asked for in these turns, in order, each with its result.
const callsOf = (turns) => turns.flatMap((turn) => turn.steps).flatMap((step) => step.calls)

// What is wrong with the calculator's work in these turns, or nothing: one call, of the
// calculator, whose result is the number expected. A result names the place of its record.
const calculated = (turns, expected) => {
  const made = callsOf(turns)
  // Count first. With no call, the loop under this line would find nothing wrong.
  if (made.length !== 1) return \`\${made.length} calls were made, not 1\`
  for (const call of made) {
    if (call.name !== "calculator") return \`the model called \${call.name}, not the calculator\`
    const result = Option.getOrUndefined(call.result)
    if (result === undefined) return "the calculator's call has no result"
    const got = JSON.stringify(result.result)
    if (result.result !== expected)
      return \`record #\${result.seq}: the calculator answered \${got}, not \${expected}\`
  }
  return undefined
}

// What is wrong with how these turns ended, or nothing: one turn for each answer expected, each
// closed as completed, with that answer.
const answered = (turns, expected) => {
  if (turns.length !== expected.length)
    return \`\${turns.length} turns were stored, not \${expected.length}\`
  for (const [index, turn] of turns.entries()) {
    const closed = Option.getOrUndefined(turn.closed)
    if (closed === undefined) return \`turn \${turn.turn} was left open\`
    if (closed.outcome._tag !== "Completed")
      return \`record #\${closed.seq}: turn \${turn.turn} closed as \${closed.outcome._tag}\`
    const answer = Option.getOrUndefined(turn.answer)
    const wanted = expected[index]
    if (answer !== wanted)
      return \`turn \${turn.turn} answered \${JSON.stringify(answer)}, not \${JSON.stringify(wanted)}\`
  }
  return undefined
}

// The checks. Each has an id, a name, the script the model follows, the messages sent, and what
// must hold of the turns the program left.
export const checks = [
  check(
    "sum",
    "a sum is worked out by the calculator, and the turn answers",
    [
      {
        _tag: "Calls",
        pieces: [],
        calls: [{ name: "calculator", params: { a: 2, op: "+", b: 3 } }],
      },
      { _tag: "Answers", pieces: ["It is 5."] },
    ],
    ["What is 2 + 3?"],
    (turns) => calculated(turns, 5) ?? answered(turns, ["It is 5."]),
  ),
  check(
    "wrong-call",
    "a call the model got wrong is a failed result, and the turn still answers",
    [
      {
        _tag: "Calls",
        pieces: [],
        calls: [{ name: "calculator", params: { a: "two", op: "+", b: 3 } }],
      },
      { _tag: "Answers", pieces: ["I could not work that out."] },
    ],
    ["What is two + 3?"],
    (turns) => {
      const results = callsOf(turns).flatMap((call) => Option.toArray(call.result))
      if (results.length !== 1) return \`\${results.length} results were stored, not 1\`
      for (const result of results) {
        if (!result.isFailure) return \`record #\${result.seq}: the call was answered, not failed\`
      }
      return answered(turns, ["I could not work that out."])
    },
  ),
  check(
    "two-turns",
    "two messages are two turns, each completed with its answer",
    [{ _tag: "Answers", pieces: ["Hello."] }],
    ["Hi.", "Still there?"],
    (turns) => answered(turns, ["Hello.", "Hello."]),
  ),
]`

/** The whole file as the learner reads it. */
export const checksDocumentOf = (checks: string): string => `${CHECKS_HEADER}${checks}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const checksBodyOf = (checks: string): string => checks.replace(/^export /gm, "")

/**
 * The lines of checks.ts that take a type in the module a test compiles, as `[from, to]`: the parameters of its
 * functions, the queue's and the pane's types, and two return types. `turnsAfter`'s says its stack needs nothing
 * more, so a stack that leaves a layer out is a compile error on that function; `check`'s says a check is the
 * kernel's `ConformanceCheck`. The last pair is the function the `live` experiment adds, and is passed over where
 * the file has none. program.test.ts fails when the starter text no longer holds one of the others.
 */
export const TYPED: ReadonlyArray<readonly [string, string]> = [
  [
    "const turnsAfter = (model, messages) =>",
    "const turnsAfter = (model: Layer.Layer<LanguageModel.LanguageModel>, messages: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<TurnRead>, unknown> =>",
  ],
  ["const replies = yield* Queue.unbounded()", "const replies = yield* Queue.unbounded<string>()"],
  ["let send = () => {}", "let send: (text: string) => void = () => {}"],
  ["const pane = {", "const pane: ChatPane = {"],
  [
    "const check = (id, name, script, messages, holds) => ({",
    "const check = (id: string, name: string, script: ModelScript, messages: ReadonlyArray<string>, holds: (turns: ReadonlyArray<TurnRead>) => string | undefined): ConformanceCheck => ({",
  ],
  ["const callsOf = (turns) =>", "const callsOf = (turns: ReadonlyArray<TurnRead>) =>"],
  ["const calculated = (turns, expected) =>", "const calculated = (turns: ReadonlyArray<TurnRead>, expected: number) =>"],
  ["const answered = (turns, expected) =>", "const answered = (turns: ReadonlyArray<TurnRead>, expected: ReadonlyArray<string>) =>"],
  [
    "const live = (id, name, runs, messages, holds) => ({",
    "const live = (id: string, name: string, runs: number, messages: ReadonlyArray<string>, holds: (turns: ReadonlyArray<TurnRead>) => string | undefined) => ({",
  ],
]

/**
 * The same file as a module a test can compile and run. `model`, which the page gives and no import names, is the
 * parameter of `checksWith`, which returns the list: the starter text names it nowhere, and the `live` experiment's
 * check runs on it.
 */
export const checksModuleOf = (checks: string): string => `${CHECKS_IMPORTS}
import type { Layer } from "effect"
import type { LanguageModel } from "effect/ai"
import type { ConformanceCheck } from "@xandreed/core"
import type { ModelScript, TurnRead } from "@xandreed/sdk"
import type { ChatPane } from "./chat.ts"

export const checksWith = (model: Layer.Layer<LanguageModel.LanguageModel>) => {
${replaced(checksBodyOf(checks), TYPED)}
  return checks
}
`
