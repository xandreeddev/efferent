// The one source of truth for lesson 16's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool) given a workspace. The loop
// offers and calls tools.ts's tools and the kernel's four file tools, merged
// into one toolkit, and main provides what the file tools need: their
// handlers, and the workspace as workspace.ts gives it. Nothing asks anyone:
// the program provides no `Approval`. The page shows IMPORTS (read-only,
// folded) above the code the learner edits; program.test.ts compiles and runs
// this exact text.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced, typedModule } from "../base/agent.source.ts"

/**
 * What this lesson replaces in the base's imports, as `[from, to]`: the file tools, their handlers and workspace.ts's
 * function, which the program uses as it starts, and the names the experiments use (`Layer`, `Predicate`, `Result`,
 * `toolResult`, `Approval`, `approveIn`, `workspacePath`): an experiment edits only the code under the imports.
 */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  ['import { Effect, Stream } from "effect"', 'import { Effect, Layer, Predicate, Result, Stream } from "effect"'],
  ['import { LanguageModel, Prompt } from "effect/ai"', 'import { LanguageModel, Prompt, Toolkit } from "effect/ai"'],
  [
    'import { Core, kernel, Sessions, turnStartedEvent, userMessage } from "@xandreed/core"',
    'import { Core, kernel, Sessions, toolResult, turnStartedEvent, userMessage } from "@xandreed/core"',
  ],
  [
    'import { callTool, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk"',
    'import { Approval, approveIn, callTool, fileHandlers, fileTools, inProcessJournal, Memory, modelAnswer, sessions, workspacePath } from "@xandreed/sdk"',
  ],
  ['import { tools, toolsLive } from "./tools.ts"', 'import { tools, toolsLive } from "./tools.ts"\nimport { workspace } from "./workspace.ts"'],
]

const TOOLKIT_LINE = "      const toolkit = yield* tools\n"

/** The toolkit the loop offers and calls: tools.ts's three, and the kernel's four, each keeping its own type. */
export const MERGED = `      // The tools: tools.ts's three, and the kernel's four that reach the workspace.
      const toolkit = yield* Toolkit.merge(tools, fileTools)
`

const PAGE_COMMENT = "// `pane` and `model` come from the page: the chat on the right, and the model you picked.\n"

/** The line this lesson adds under the base's comment on what the page gives: `files`, and `approvalOn`. */
export const PAGE_GIVES = "// So do `files`, the page's workspace, and `approvalOn`, who is asked: you, in the chat.\n"

const TOOLS_LINE = "  Effect.provide(toolsLive), // what each tool does when it is called\n"

/** The two lines this lesson adds to main: what the file tools do, and the workspace they reach. */
export const FILES_LINES = `  Effect.provide(fileHandlers), // what the file tools do: they read and write, and ask no one
  Effect.provide(workspace(files)), // the files, as workspace.ts lets the agent reach them
`

/** What this lesson replaces in the base's program, as `[from, to]`: the toolkit, one comment line, two modules. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [TOOLKIT_LINE, MERGED],
  [PAGE_COMMENT, `${PAGE_COMMENT}${PAGE_GIVES}`],
  [TOOLS_LINE, `${TOOLS_LINE}${FILES_LINES}`],
]

/** Read-only: what the program imports. */
export const IMPORTS = replaced(BASE_IMPORTS, REPLACED_IMPORTS)

/** What the learner edits: the base program, given the workspace's tools. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/** What the typed module replaces in the base's, as `[from, to]`: `approvalOn` and `files` are parameters of `run`. */
export const TYPED: ReadonlyArray<readonly [string, string]> = [
  // The shown imports hold `Layer` already: the base's own type import of it would be a second.
  ['import type { Layer } from "effect"\n', 'import type { Files } from "@xandreed/sdk"\n'],
  [
    "export const run = (pane: ChatPane,",
    "export const run = (approvalOn: (pane: ChatPane) => Layer.Layer<Approval>, files: Layer.Layer<Files>, pane: ChatPane,",
  ],
]

/**
 * The same file as a module a test can compile and run, as the base's. `approvalOn` and `files` are parameters of
 * `run`, as `pane` and `model` are: a test hands them a host and a workspace of its own, typed as the contracts are.
 * `run` still states that its program needs nothing more, so a program that leaves out the workspace, or that asks
 * and provides no `Approval`, does not compile.
 */
export const moduleOf = (agent: string): string => replaced(replaced(typedModule(IMPORTS, agent), TYPED), [JUDGE_TYPED])

/**
 * The one line of the judge experiment's text that needs a type, as `[from, to]`: the person's approval it wraps. The
 * starter has no judge, and this piece is left out of it.
 */
export const JUDGE_TYPED: readonly [string, string] = ["const judgedFirst = (person) =>", "const judgedFirst = (person: Layer.Layer<Approval>) =>"]
