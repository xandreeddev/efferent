import { Effect, Layer, Match } from "effect"
import type { Option } from "effect"
import { messageOf, readJournal } from "@xandreed/core/kernel"
import type { Message, OpenSession, StoredEvent } from "@xandreed/core/kernel"
import { budgetOf, estimateTokens, paired, promptMessage } from "../../contracts/memory/memory.entity.functions.js"
import { OverBudget } from "../../contracts/memory/memory.entity.js"
import type { InvalidBudget } from "../../contracts/memory/memory.entity.js"
import { Memory } from "../../contracts/memory/memory.port.js"
import { pointed } from "../../contracts/memory/pointer.entity.functions.js"
import { SummaryFailed } from "../../contracts/summary/summarizer.entity.js"
import { Summarizer } from "../../contracts/summary/summarizer.port.js"
import { CurrentTurn } from "../../contracts/turn/current-turn.port.js"
import { runningTurn } from "../../contracts/turn/running-turn.entity.functions.js"
import { plan, SUMMARY_VOCABULARY, summarized, summaryNote } from "./summary.entity.functions.js"
import type { SummaryOptions } from "./summary.entity.js"

/**
 * The summary memory: every message of the conversation while it fits the
 * budget; when it does not, the oldest closed turns are folded, with the
 * summary so far, into a new summary by the host's `Summarizer`, stored once
 * as `plugin.summary.summarized` (tagged `memory`, the summary its message).
 * Every later context starts with that summary's note, so the prefix a
 * provider cached holds from one compaction to the next. One summary at most
 * per context: a summary too long to fit beside the turns that stay is not
 * stored, and the context fails with `OverBudget` (the next context asks
 * again); when even folding every closed turn could not fit, it fails so
 * without asking for one. A summarizer that fails fails the
 * context with its `SummaryFailed`, and nothing is stored; one that answers
 * with nothing fails it the same way, since a stored summary stays. A budget that is
 * no finite number of at least one token fails the layer with
 * `InvalidBudget`. With `pointers`, a long tool result is read as its
 * pointer (`pointed`) before anything is counted or folded, so the
 * summarizer is handed what the model was sent; pointer options that are
 * none are refused where the layer is made.
 *
 * @public
 */
export const summaryMemory = (options: SummaryOptions): Layer.Layer<Memory, InvalidBudget, Summarizer> => {
  // How a record's message is read: as stored, or a long result as its pointer. Options that are none throw here.
  const sent = options.pointers === undefined ? messageOf : pointed(options.pointers)
  return summaryMemoryOver(options, sent)
}

/** The summary memory's layer, reading each record's message with `sent`. */
const summaryMemoryOver = (options: SummaryOptions, sent: (record: StoredEvent) => Option.Option<Message>): Layer.Layer<Memory, InvalidBudget, Summarizer> => Layer.effect(Memory, Effect.gen(function* () {
  const summarizer = yield* Summarizer
  const budget = yield* Effect.fromResult(budgetOf(options.budgetTokens))
  const keepTurns = options.keepTurns ?? 1

  const planned = (session: OpenSession) => Effect.map(
    Effect.flatMap(session.journal, (journal) => Effect.fromResult(readJournal(SUMMARY_VOCABULARY)(journal))),
    (known) => plan(known, session.turn, budget, keepTurns, sent),
  )
  const over = (estimatedTokens: number, why = "with nothing more to fold") => new OverBudget({
    estimatedTokens: OverBudget.fields.estimatedTokens.make(estimatedTokens),
    budgetTokens: budget,
    message: `the context is estimated at ${estimatedTokens} tokens, over the budget of ${budget}, ${why}`,
  })

  return Memory.of({
    context: Effect.fn("summary_memory.context")(function* (session: OpenSession) {
      const first = yield* planned(session)
      const fitted = yield* Match.valueTags(first, {
        Fits: (fits) => Effect.succeed(fits),
        Over: (it) => Effect.fail(over(it.estimatedTokens)),
        // Fold once: summarize, store the summary, and plan again from the journal as it now stands.
        Fold: (fold) => Effect.gen(function* () {
          // The summarizer works for this turn: what it calls (a model, through a wrapper) reaches the session as `CurrentTurn`.
          const summary = yield* summarizer.summarize({ earlier: fold.earlier, messages: fold.fold }).pipe(Effect.provideService(CurrentTurn, runningTurn(session)))
          // A summary stands for the turns it folds, for good: one that says nothing is not stored.
          if (summary.trim().length === 0) return yield* Effect.fail(new SummaryFailed({ message: "the summarizer answered with nothing, so no summary was stored" }))
          // A summary too long to fit beside what stays is not stored: the next context asks again.
          const estimated = estimateTokens(summaryNote(summary)) + fold.kept
          if (estimated > budget) return yield* Effect.fail(over(estimated, "with a summary too long to fit beside the turns that stay: it was not stored"))
          yield* session.append(summarized(fold.through, summary))
          const again = yield* planned(session)
          return yield* Match.valueTags(again, {
            Fits: (fits) => Effect.succeed(fits),
            Over: (it) => Effect.fail(over(it.estimatedTokens)),
            Fold: (it) => Effect.fail(over(it.estimatedTokens)), // one summary per context, never a second
          })
        }),
      })
      return paired(fitted.messages).map(promptMessage)
    }),
  })
}))
