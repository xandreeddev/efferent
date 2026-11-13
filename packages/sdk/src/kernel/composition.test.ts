import { describe, expect, test } from "bun:test"
import { Layer } from "effect"
import type { LanguageModel } from "effect/ai"
import { kernel } from "@xandreed/core/kernel"
import type { Core, JournalStorage, Sessions } from "@xandreed/core/kernel"
import type { Memory } from "./contracts/memory/memory.port.js"
import { inbox, inProcessJournal, sessions, windowMemory } from "./index.js"
import type { Inbox, InvalidBudget } from "./index.js"
import { testTurn } from "./testing.js"

/*
 * A stack's type says what it provides and what it still needs, so a stack
 * whose type is written out does not compile when a part is missing: the
 * error lands on the line that annotates it.
 */

/** Everything an agent of the stock parts provides, needing nothing. */
type Agent = Layer.Layer<Inbox | Memory | Sessions | JournalStorage | Core | LanguageModel.LanguageModel, InvalidBudget>

const complete = (model: Layer.Layer<LanguageModel.LanguageModel>) => {
  const AgentLive: Agent = inbox(testTurn("You are a friendly tutor.")).pipe(
    Layer.provideMerge(windowMemory({ budgetTokens: 3000 })),
    Layer.provideMerge(sessions()),
    Layer.provideMerge(inProcessJournal()),
    Layer.provideMerge(kernel()),
    Layer.provideMerge(model),
  )
  return AgentLive
}

const withoutSessions = (model: Layer.Layer<LanguageModel.LanguageModel>) => {
  // @ts-expect-error the stack leaves out `sessions()`: it still needs `Sessions` and does not provide it
  const AgentLive: Agent = inbox(testTurn("You are a friendly tutor.")).pipe(
    Layer.provideMerge(windowMemory({ budgetTokens: 3000 })),
    Layer.provideMerge(inProcessJournal()),
    Layer.provideMerge(kernel()),
    Layer.provideMerge(model),
  )
  return AgentLive
}

const withoutTheModel = () => {
  // @ts-expect-error the stack leaves out the model: the turn the inbox runs still needs `LanguageModel`
  const AgentLive: Agent = inbox(testTurn("You are a friendly tutor.")).pipe(
    Layer.provideMerge(windowMemory({ budgetTokens: 3000 })),
    Layer.provideMerge(sessions()),
    Layer.provideMerge(inProcessJournal()),
    Layer.provideMerge(kernel()),
  )
  return AgentLive
}

const sessionsBelowTheJournal = (model: Layer.Layer<LanguageModel.LanguageModel>) => {
  // @ts-expect-error the session plugin is built before the journal it needs: what a layer needs is provided by the layers below it
  const AgentLive: Agent = inbox(testTurn("You are a friendly tutor.")).pipe(
    Layer.provideMerge(windowMemory({ budgetTokens: 3000 })),
    Layer.provideMerge(inProcessJournal()),
    Layer.provideMerge(sessions()),
    Layer.provideMerge(kernel()),
    Layer.provideMerge(model),
  )
  return AgentLive
}

describe("a stack of layers", () => {
  test("type-level: a stack missing a part, or with a part below what it needs, does not compile where its type is annotated", () => {
    // The checks are the compiler's: this file compiles only because each incomplete stack is an error, and the complete one is not.
    expect([complete, withoutSessions, withoutTheModel, sessionsBelowTheJournal]).toHaveLength(4)
  })
})
