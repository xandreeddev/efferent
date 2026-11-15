// The one source of truth for lesson 10's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool) with three changes. The
// system text ends with the catalogue of skills. The loop reads what to
// offer at each step, from the journal, where the base took its toolkit once
// before the loop. And main provides two modules more: the handlers of the
// units skill's tool, and the handler of loadSkill. The page shows IMPORTS
// (read-only, folded) above the code the learner edits; program.test.ts
// compiles and runs this exact text.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced, typedModule } from "../base/agent.source.ts"

/**
 * What this lesson replaces in the base's imports, as `[from, to]`. The program no longer names `tools`: what it
 * offers comes from `skillSet`. It names `units` and `haiku` in no line as it starts: the `always-on` experiment
 * does, and an experiment edits only the code under the imports.
 */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  [
    'import { tools, toolsLive } from "./tools.ts"',
    'import { haiku, skillSet, units, unitsLive } from "./skills.ts"\nimport { toolsLive } from "./tools.ts"',
  ],
]

/** The base's system text: one statement, with its comment. */
const BASE_SYSTEM = `// The system text: code, sent first in every prompt, never stored.
const system =
  "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."
`

/** The same sentence under a name of its own: what the system text starts with. */
export const OPENING = `// The system text: code, sent first in every prompt, never stored.
const opening =
  "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."
`

/** The system text of this lesson: the opening, then the catalogue. */
export const SYSTEM = `// It ends with the catalogue: one line per skill, and how to load one. The catalogue names every
// skill and says nothing of which are loaded, so the system text is the same in every prompt.
const system = \`\${opening}\\n\\n\${skillSet.catalogue}\`
`

/** The base's one read of its toolkit, before the loop. */
const TOOLKIT_ONCE = "      const toolkit = yield* tools\n"

const LOOP_START = "      for (let step = 1; step <= MAX_STEPS; step++) {\n"

/** What this lesson's loop does first at each step: it reads what to offer. */
export const OFFERED = `        // What is offered is read from the journal at each step: the tools no skill owns, then each
        // loaded skill's. The same toolkit goes to the model and to callTool.
        const toolkit = yield* skillSet.offered(yield* session.journal)
`

const TOOLS_LINE = "  Effect.provide(toolsLive), // what each tool does when it is called\n"

/** main's line for the units skill's handlers. */
export const UNITS_LINE = "  Effect.provide(unitsLive), // what the units skill's tool does, loaded or not\n"

/** main's line for `loadSkill`'s handler. */
export const LOADER_LINE = "  Effect.provide(skillSet.handlers), // what loadSkill does: it answers a skill's instructions\n"

/** What this lesson replaces in the base's program, as `[from, to]`: the system text, where the toolkit is read, and two modules more. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [BASE_SYSTEM, `${OPENING}\n${SYSTEM}`],
  [TOOLKIT_ONCE, ""],
  [LOOP_START, `${LOOP_START}${OFFERED}`],
  [TOOLS_LINE, `${TOOLS_LINE}${UNITS_LINE}${LOADER_LINE}`],
]

/** Read-only: what the program imports. */
export const IMPORTS = replaced(BASE_IMPORTS, REPLACED_IMPORTS)

/** What the learner edits: the base program, offering at each step what the journal says is loaded. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * The same file as a module a test can compile and run, as the base's: `run` states that its program needs nothing
 * more, so a program that leaves out a skill's handlers, or `loadSkill`'s, does not compile.
 */
export const moduleOf = (agent: string): string => typedModule(IMPORTS, agent)
