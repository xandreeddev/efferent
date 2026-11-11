// Lesson 1's last step: a memory strategy written by the learner. The editable
// part is the arrow function `tinyMemory(n)`, which returns a real plugin that
// provides ConversationMemory. The lesson's test runs this exact text.

/** Read-only: where each name the plugin uses comes from. */
export const TINY_IMPORTS = `import { Effect, Layer, Option, Schema } from "effect"
import { ConversationMemory, definePlugin, ledgerOf, openLogSession } from "@xandreed/core"

`

export const TINY_INTRO = `${TINY_IMPORTS}// tiny-memory.ts: a memory strategy is just a plugin.
// It decides what the model sees of the journal. This one keeps the last n turns
// (the current one included) and replaces older ones with a short ledger note.
// The journal keeps everything.
const tinyMemory = `

/** The editable plugin factory, as plain JavaScript. */
export const DEFAULT_TINY = `(n) => {
  const strategy = { id: "keep-last", version: "1" }

  // The newest turn an earlier compaction of this strategy already dropped.
  const droppedThrough = (entries) =>
    Math.max(
      0,
      ...entries.flatMap(({ body }) =>
        body._tag === "Compaction" &&
        body.strategy === strategy.id &&
        body.action._tag === "DropTurns"
          ? [body.action.throughTurn]
          : [],
      ),
    )

  // After each turn: keep the last n turns; older ones become one ledger note.
  const maintain = ({ entries, turn }) =>
    Effect.sync(() => {
      const dropThrough = turn - n
      return dropThrough > droppedThrough(entries)
        ? {
            actions: [
              {
                _tag: "DropTurns",
                throughTurn: dropThrough,
                ledger: ledgerOf(entries, dropThrough, 40),
              },
            ],
            digest: [],
          }
        : { actions: [], digest: [] }
    })

  const policy = {
    strategy,
    render: {
      turnContext: "current",
      replies: true,
      digests: false,
      media: { mode: "none", maxImages: 0, maxChars: 0 },
    },
    digestOnWrite: Option.none(),
    maintain,
  }

  return definePlugin({
    id: "tiny-memory",
    version: "1",
    scope: "runtime",
    config: Schema.Struct({}),
    defaults: {},
    provides: [ConversationMemory],
    layer: () =>
      Layer.sync(ConversationMemory, () =>
        ConversationMemory.of({
          strategy,
          open: ({ runId, log }) => openLogSession(log, policy, { runId }),
        }),
      ),
  })
}`

export const TINY_FOOTER = `
// Use it in agent.ts:  plugins: [tinyMemory(2), ...]`

export const tinyProgramOf = (tiny: string): string => `${TINY_INTRO}${tiny}${TINY_FOOTER}`

/** The same file as a module the test can run. */
export const tinyModuleOf = (tiny: string): string => `${TINY_IMPORTS}export const tinyMemory = ${tiny}\n`

/** The names the tiny plugin's code may use (the framework pieces a memory plugin is made of). */
export const TINY_NAMES = ["Schema", "definePlugin", "ConversationMemory", "openLogSession", "ledgerOf", "Layer", "Effect", "Option"] as const
