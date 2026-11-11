// The one source of truth for Lesson 1's code. The page shows IMPORTS, SETUP,
// the editable CONFIG and DEFINE as one program; the runtime evaluates the
// config the learner edits; lesson1.program.test.ts compiles and runs this
// exact text through the real framework, so what is shown cannot drift.

/** Read-only: what the program imports. */
export const IMPORTS = `import { Context, Effect, Layer, Option } from "effect"
import { LanguageModel } from "effect/ai"
import { Agent, RunId, Sessions, SessionLogMemoryLive, TurnAdmissionOpen, UserMessage } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"`

/** Read-only: the session (the journal's home). It stays visible in the journal step. */
export const SESSION = `// Conversations live in memory. This page keeps them across rebuilds.
const sessionsLayer = SessionsLive(sessionsDefaults).pipe(
  Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
)
const sessions = Context.get(yield* Layer.build(sessionsLayer), Sessions)`

/** Read-only: the line before the editable object. */
export const AGENT_INTRO = `// The agent: three plugins and a system prompt. Edit this object.
const config = `

export const SETUP = `${SESSION}\n\n${AGENT_INTRO}`

/** What the learner edits: the agent's configuration, as a plain object. */
export const DEFAULT_CONFIG = `{
  system: "You are a friendly tutor. Keep answers short.",
  plugins: [
    memoryWindowPlugin, // remembers the chat
    {
      plugin: toolDiscoveryPlugin,
      options: { loadSkill: false }, // offer no tools
    },
    stepLoopPlugin, // the loop itself
  ],
  limits: { maxSteps: 10, streaming: true },
  budgetTokens: 3000, // small models, small windows
}`

/** Read-only: define the agent, then run one turn. \`model\` and \`text\` come from the page. */
export const DEFINE = `
const agent = yield* Agent.define({ ...config, turnServices: [LanguageModel.LanguageModel] })

// One message in, one reply out. The loop runs inside agent.turn.
const view = yield* sessions.create({ owner: "learner" })
const outcome = yield* agent.turn(
  {
    turn: {
      session: { id: view.header.id, owner: "learner" },
      userMessage: new UserMessage({ text }),
      runId: RunId.make(crypto.randomUUID()),
    },
    services: Context.merge(
      Context.make(LanguageModel.LanguageModel, model),
      Context.make(Sessions, sessions),
    ),
  },
  (turn) =>
    turn.run({}).pipe(
      Effect.map((result) => ({
        outcome: result.outcome,
        reply: result.outcome === "waiting" ? Option.none() : Option.some(result.text),
      })),
    ),
)`

/** Everything before the editable object. */
export const HEADER = `${IMPORTS}\n\n${SETUP}`

/** Where each foldable, read-only section starts and ends in `programOf(...)` (offsets are the same for any config). */
export const SECTIONS = {
  imports: { from: 0, to: IMPORTS.length },
  session: { from: IMPORTS.length + 2, to: IMPORTS.length + 2 + SESSION.length },
  configFrom: HEADER.length,
}

/** The first text of the read-only define-and-run section (the editor finds the section by it). */
export const DEFINE_START_MARK = "const agent = yield* Agent.define"

/** The whole program as the learner reads it. */
export const programOf = (config: string): string => `${HEADER}${config}\n${DEFINE}`

/** The same program as a module the test can run: `model` and `text` become parameters. */
export const moduleOf = (config: string): string =>
  `${IMPORTS}\nexport const program = (model: LanguageModel.LanguageModel, text: string) =>\n  Effect.scoped(Effect.gen(function* () {\n${SETUP}${config}\n${DEFINE}\n  return outcome\n}))\n`
