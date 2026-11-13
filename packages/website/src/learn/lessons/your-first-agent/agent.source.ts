// The one source of truth for Lesson 1's code. The page shows IMPORTS, BASE,
// the editable AGENT and RUN as one program; the lesson evaluates the agent
// expression the learner edits; program.test.ts compiles and runs
// this exact text on the kernel, so what is shown cannot drift.

/** Read-only: what the program imports. */
export const IMPORTS = `import { Effect, Layer } from "effect"
import { Core, kernel, Sessions, turnEndedEvent } from "@xandreed/core/kernel"
import { assistantDeltaEvent, Inbox, inbox, inboxQueuedEvent, inProcessJournal, sessions, settings, stepLoop, windowMemory } from "@xandreed/sdk/kernel"
import { lastMessages } from "./tiny-memory.ts"`

/** Read-only: the base, built once. The conversation lives here. */
export const BASE = `// The base: events, a journal kept in memory, and sessions.
// This page builds it once, so the conversation outlives every rebuild.
const Base = sessions().pipe(
  Layer.provideMerge(inProcessJournal()),
  Layer.provideMerge(kernel()),
)`

/** Read-only: the line before the editable expression. */
export const AGENT_INTRO = `// The agent: the inbox over the loop, a memory and the system text. Edit it.
const Agent = `

/** What the learner edits: the layers above the base, as one expression. */
export const DEFAULT_AGENT = `inbox.pipe(
  Layer.provideMerge(stepLoop),
  Layer.provideMerge(windowMemory({ budgetTokens: 3000 })),
  Layer.provideMerge(settings({ system: "You are a friendly tutor. Keep answers short." })),
)`

/** Read-only: follow the session, then queue the messages. `model`, `messages` and `show` come from the page. */
export const RUN = `// Run it. On this page Rebuild builds Agent again over the same Base.
// \`model\`, \`messages\` and \`show\` come from the page.
const program = Effect.gen(function* () {
  const core     = yield* Core
  const sessions = yield* Sessions
  const inbox    = yield* Inbox
  const session  = yield* sessions.create({ owner: "learner" })

  // Draw the chat from events. A listener is registered before \`on\` returns.
  yield* core.on(inboxQueuedEvent, (queued) => show(\`queued #\${queued.data.ticket}\`), { name: "page", wait: true })
  yield* core.on(assistantDeltaEvent, (delta) => show(delta.data.text), { name: "page", wait: true })
  yield* core.on(turnEndedEvent, (ended) => show(\`turn \${ended.data.turn} ended\`), { name: "page", wait: true })

  // Queue every message at once. Each is answered in a turn of its own, in order.
  const queued = yield* Effect.forEach(messages, (message) => inbox.enqueue(session, message), { concurrency: 1 })
  return yield* Effect.forEach(queued, (entry) => entry.reply, { concurrency: "unbounded" })
}).pipe(
  Effect.scoped,
  Effect.provide(Agent.pipe(Layer.provideMerge(Base), Layer.provideMerge(model))),
)`

/** Everything before the editable expression. */
export const HEADER = `${IMPORTS}\n\n${BASE}\n\n${AGENT_INTRO}`

/** The first text of the read-only run section (the editor finds the section by it). */
export const RUN_START_MARK = "// Run it."

/** The whole program as the learner reads it. */
export const programOf = (agent: string): string => `${HEADER}${agent}\n\n${RUN}`

/**
 * The same program as a module a test can compile and run: `model`,
 * `messages` and `show` become parameters, and `program` is returned.
 */
export const moduleOf = (agent: string): string => `${IMPORTS}
import type { LanguageModel } from "effect/ai"

export const run = (
  model: Layer.Layer<LanguageModel.LanguageModel>,
  messages: ReadonlyArray<string>,
  show: (text: string) => Effect.Effect<void>,
) => {
${BASE}

${AGENT_INTRO}${agent}

${RUN}
  return program
}
`
