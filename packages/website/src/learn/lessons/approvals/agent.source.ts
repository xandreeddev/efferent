// The one source of truth for lesson 9's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool) with one line more in main.
// A tool of tools.ts asks before it acts, and the program that calls it is
// the one that needs somebody to ask: main provides the page's approval,
// `approvalOn(pane)`. Nothing in the loop changes. The page shows IMPORTS
// (read-only, folded) above the code the learner edits; program.test.ts
// compiles and runs this exact text.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced, typedModule } from "../base/agent.source.ts"

/**
 * What this lesson replaces in the base's imports, as `[from, to]`. The program as it starts uses none of the three
 * names: two experiments do (`autoApprove`, a policy before the person; `approveIn` and `toolResult`, a loop that
 * asks before every call), and an experiment edits only the code under the imports.
 */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  [
    'import { Core, kernel, Sessions, turnStartedEvent, userMessage } from "@xandreed/core/kernel"',
    'import { Core, kernel, Sessions, toolResult, turnStartedEvent, userMessage } from "@xandreed/core/kernel"',
  ],
  [
    'import { callTool, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk/kernel"',
    'import { approveIn, autoApprove, callTool, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk/kernel"',
  ],
]

const PAGE_COMMENT = "// `pane` and `model` come from the page: the chat on the right, and the model you picked.\n"

/** The line this lesson adds under the base's comment on what the page gives. */
export const APPROVAL_COMMENT = "// So does `approvalOn`: who a tool asks is the host's part, and here the host is this page.\n"

const TOOLS_LINE = "  Effect.provide(toolsLive), // what each tool does when it is called\n"

/** The line this lesson adds to main: the page's approval, given to the program that calls the tools. */
export const APPROVAL_LINE = "  Effect.provide(approvalOn(pane)), // who a tool asks before it acts: you, in the chat\n"

/** What this lesson replaces in the base's program, as `[from, to]`: one comment line more, and one module more. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [PAGE_COMMENT, `${PAGE_COMMENT}${APPROVAL_COMMENT}`],
  [TOOLS_LINE, `${TOOLS_LINE}${APPROVAL_LINE}`],
]

/** Read-only: what the program imports. */
export const IMPORTS = replaced(BASE_IMPORTS, REPLACED_IMPORTS)

/** What the learner edits: the base program, given somebody to ask. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * The same file as a module a test can compile and run, as the base's. `approvalOn` is a parameter of `run` there,
 * as `pane` and `model` are: a test hands it a host of its own, typed as the contract is. `run` still states that
 * its program needs nothing more, so a program that provides no `Approval` does not compile.
 */
export const moduleOf = (agent: string): string =>
  typedModule(IMPORTS, agent)
    .replace('import type { Layer } from "effect"', 'import type { Layer } from "effect"\nimport type { Approval } from "@xandreed/sdk/kernel"')
    .replace("export const run = (pane: ChatPane,", "export const run = (approvalOn: (pane: ChatPane) => Layer.Layer<Approval>, pane: ChatPane,")
