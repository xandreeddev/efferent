// The one source of truth for lesson 17's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool) given background tasks. The
// loop offers and calls the kernel's two task tools beside tools.ts's three,
// and takes what comes in from the chat's one queue (`chat.inputs`): a
// message, as before, or a task's report, stored with `taskReport` in the
// session that started the task. main provides the task tools' handlers, the
// tasks plugin over helper.ts's helper, and the page's `reportsOn(pane)`,
// which puts a report in that queue; they come before tools.ts's handlers,
// which the helper's tool calls use too. The boot hook names only the
// conversation's turns: a task's turn runs in a session of its own. The page
// shows IMPORTS (read-only, folded) above the code the learner edits;
// program.test.ts compiles and runs this exact text.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced, typedModule } from "../base/agent.source.ts"

/**
 * What this lesson replaces in the base's imports, as `[from, to]`: `Toolkit` to merge the tools, the kernel's task
 * tools, their handlers, the plugin and `taskReport`, and helper.ts's helper.
 */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  ['import { LanguageModel, Prompt } from "effect/ai"', 'import { LanguageModel, Prompt, Toolkit } from "effect/ai"'],
  [
    'import { callTool, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk/kernel"',
    'import { callTool, inProcessJournal, Memory, modelAnswer, sessions, taskHandlers, taskReport, tasks, taskTools } from "@xandreed/sdk/kernel"',
  ],
  ['import { flatMemory } from "./memory.ts"', 'import { helper } from "./helper.ts"\nimport { flatMemory } from "./memory.ts"'],
]

/** The base's comment and first line of the turn: it takes a message. */
const TURN_HEAD = `// One turn: a loop. The model answers, or asks for tools; their results are stored,
// and the model is asked again.
const turn = (message) =>`

/** This lesson's: the turn takes one input, a message or a report. */
export const INPUT_TURN = `// One turn, for one input: your message, or a task's report. A loop: the model answers, or
// asks for tools; their results are stored, and the model is asked again.
const turn = (input) =>`

const TOOLKIT_LINE = "      const toolkit = yield* tools\n"

/** The toolkit the loop offers and calls: tools.ts's three, and the kernel's two, each keeping its own type. */
export const MERGED = `      // The tools: tools.ts's three, and the kernel's two that start and cancel a task.
      const toolkit = yield* Toolkit.merge(tools, taskTools)
`

/** The base's lines that store the turn's message and the ones that waited behind it. */
const STORE_MESSAGE = `      const session = yield* sessions.open(chat.session)
      // Store your message, and every one that waited behind it: this turn answers them all.
      const waiting = yield* chat.drain
      for (const text of [message, ...waiting]) {
        yield* session.append(userMessage(text))
      }
`

/** The loop's one change: a report is stored with `taskReport`, in the session that started the task. */
export const STORE_INPUT = `      // A task's report goes to the session that started the task, stored with taskReport: a
      // message whose \`from\` is the task's session, so nothing takes it for your words. Your
      // message goes to the chat's session, as before.
      const session = yield* sessions.open(
        input._tag === "Report" ? input.report.parent : chat.session,
      )
      yield* session.append(
        input._tag === "Report" ? taskReport(input.report) : userMessage(input.text),
      )
      // Store every message that waited behind it: this turn answers them all. A report that
      // waits is not taken: it gets a turn of its own.
      const waiting = yield* chat.drain
      for (const text of waiting) {
        yield* session.append(userMessage(text))
      }
`

/** The base's boot hook, which names every turn that starts, in any session. */
const BOOT_HOOK = `    // On boot: hook an event, as a Neovim autocmd would. Here, the chat's status line names each turn.
    yield* core.on(turnStartedEvent, ({ data }) => chat.status(\`turn \${data.turn}\`), {
      name: "boot",
      wait: true,
    })
`

/** This lesson's boot hook: it names the conversation's turns, and passes over a task's. */
export const CHAT_HOOK = `    // On boot: hook an event, as a Neovim autocmd would. Here, the chat's status line names each
    // turn of the conversation. A task's turn, in a session of its own, is passed over.
    yield* core.on(
      turnStartedEvent,
      (event) =>
        event.session === chat.session ? chat.status(\`turn \${event.data.turn}\`) : Effect.void,
      { name: "boot", wait: true },
    )
`

/** The base's loop over the messages. */
const ON_EACH_MESSAGE = `    // Then, on each message you send: one turn, in order.
    yield* Stream.runForEach(chat.messages, (message) =>
      turn(message).pipe(`

/** This lesson's: over what comes in, a message or a report, one at a time. */
export const ON_EACH_INPUT = `    // Then, on each message you send and each task's report: one turn, in the order they came.
    yield* Stream.runForEach(chat.inputs, (input) =>
      turn(input).pipe(`

const PAGE_COMMENT = "// `pane` and `model` come from the page: the chat on the right, and the model you picked.\n"

/** The line this lesson adds under the base's comment on what the page gives: `reportsOn`. */
export const PAGE_GIVES = "// So does `reportsOn`, which puts a task's report in the chat's queue, behind your messages.\n"

const TOOLS_LINE = "  Effect.provide(toolsLive), // what each tool does when it is called\n"

/** main's line that provides the tasks plugin over the helper: the line the one-at-a-time experiment edits. */
export const TASKS_LINE = "  Effect.provide(tasks(helper)), // tasks: each one runs the helper in a session of its own\n"

/** The three lines this lesson adds to main: what the task tools do, the plugin, and where a report goes. */
export const TASK_LINES = `  Effect.provide(taskHandlers), // what startTask and cancelTask do
${TASKS_LINE}  Effect.provide(reportsOn(pane)), // where a task's report goes: the chat's queue
`

/**
 * What this lesson replaces in the base's program, as `[from, to]`. program.test.ts fails when the base no longer
 * holds one. The task lines go before tools.ts's handlers in main: the helper calls tools.ts's tools too, and a
 * module can use only the ones given after it.
 */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [TURN_HEAD, INPUT_TURN],
  [TOOLKIT_LINE, MERGED],
  [STORE_MESSAGE, STORE_INPUT],
  [BOOT_HOOK, CHAT_HOOK],
  [ON_EACH_MESSAGE, ON_EACH_INPUT],
  [PAGE_COMMENT, `${PAGE_COMMENT}${PAGE_GIVES}`],
  [TOOLS_LINE, `${TASK_LINES}${TOOLS_LINE}`],
]

/** Read-only: what the program imports. */
export const IMPORTS = replaced(BASE_IMPORTS, REPLACED_IMPORTS)

/** What the learner edits: the base program, given background tasks. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * What the typed module replaces in the base's, as `[from, to]`: the turn's input is typed as chat.ts's `Input`,
 * and `reportsOn` is a parameter of `run`, as `pane` and `model` are.
 */
export const TYPED: ReadonlyArray<readonly [string, string]> = [
  ['import type { ChatPane } from "./chat.ts"', 'import type { ChatPane, Input } from "./chat.ts"\nimport type { TaskReports } from "@xandreed/sdk/kernel"'],
  ["export const run = (pane: ChatPane,", "export const run = (reportsOn: (pane: ChatPane) => Layer.Layer<TaskReports>, pane: ChatPane,"],
  ["const turn = (input) =>", "const turn = (input: Input) =>"],
]

/**
 * The same file as a module a test can compile and run, as the base's. `reportsOn` is a parameter of `run`: a test
 * hands it a part of its own that puts a report in its chat's queue, typed as the contract is. `run` still states
 * that its program needs nothing more, so a program that leaves out the tasks plugin, or where a report goes, does
 * not compile.
 */
export const moduleOf = (agent: string): string => replaced(typedModule(IMPORTS, agent), TYPED)
