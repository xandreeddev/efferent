// Lesson 1's last step: a memory written by the learner. The editable part is
// the arrow function `lastMessages`, which returns a layer that provides
// Memory. The page evaluates this exact text; the lesson's tests run it
// through the memory kit and compile it as TypeScript.

/** Read-only: where each name the memory uses comes from. */
export const TINY_IMPORTS = `import { Effect, Layer, Option } from "effect"
import { messageOf, readerFor, readJournal } from "@xandreed/core/kernel"
import { estimateRequest, LOOP_READER, Memory, OverBudget, Settings, Tokens } from "@xandreed/sdk/kernel"

`

/** Read-only: what the editable function must be. */
export const TINY_TYPE = `(options: { readonly n: number; readonly budgetTokens: number }) => Layer.Layer<Memory, never, Settings>`

export const TINY_INTRO = `${TINY_IMPORTS}// tiny-memory.ts: a memory is a layer that provides Memory.
// This one sends the last n messages, fewer when they do not fit the budget.
// The journal keeps everything.
export const lastMessages: ${TINY_TYPE} = `

/** The editable memory, as plain JavaScript. */
export const DEFAULT_TINY = `({ n, budgetTokens }) =>
  Layer.effect(
    Memory,
    Effect.gen(function* () {
      const settings = yield* Settings
      // Refuse options that are no numbers here, in words, rather than at the first message.
      if (!(n >= 1) || !(budgetTokens >= 1)) {
        return yield* Effect.die(
          new RangeError(
            \`lastMessages needs n and budgetTokens, each a number of 1 or more: lastMessages({ n: 1, budgetTokens: 3000 })\`,
          ),
        )
      }
      const budget = Tokens.make(Math.floor(budgetTokens))
      // It reads core's records, the loop's, and its own (it writes none).
      const reader = readerFor("last", [], LOOP_READER)

      return Memory.of({
        build: (session) =>
          Effect.gen(function* () {
            const journal = yield* Effect.fromResult(readJournal(reader)(yield* session.journal))
            // Every record that bears a message. The last one is the message this turn answers.
            const said = journal.filter((record) => record.message !== undefined)
            // Start from the last n; while that is over the budget, leave out the oldest.
            for (let from = Math.max(0, said.length - Math.floor(n)); from < said.length; from++) {
              const kept = said.slice(from)
              const estimatedTokens = estimateRequest(
                settings.system,
                kept.flatMap((record) => Option.toArray(messageOf(record))),
              )
              if (estimatedTokens <= budget) {
                // Pointers into the journal, never copies.
                return {
                  messages: kept.map((record) => record.seq),
                  estimatedTokens,
                  budgetTokens: budget,
                }
              }
            }
            // Even the current message alone does not fit.
            const estimatedTokens = estimateRequest(
              settings.system,
              said.slice(-1).flatMap((record) => Option.toArray(messageOf(record))),
            )
            return yield* Effect.fail(
              new OverBudget({
                estimatedTokens,
                budgetTokens: budget,
                message: \`the current message is estimated at \${estimatedTokens} tokens, over the budget of \${budget}\`,
              }),
            )
          }),
      })
    }),
  )`

export const TINY_FOOTER = `

// Use it in agent.ts: Layer.provideMerge(lastMessages({ n: 3, budgetTokens: 3000 }))`

export const tinyProgramOf = (tiny: string): string => `${TINY_INTRO}${tiny}${TINY_FOOTER}`

/** The same file as a module a test can compile: the editable text is typed by `TINY_TYPE`. */
export const tinyModuleOf = (tiny: string): string => `${TINY_IMPORTS}export const lastMessages: ${TINY_TYPE} = ${tiny}\n`
