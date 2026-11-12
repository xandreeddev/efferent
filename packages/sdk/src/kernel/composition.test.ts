import { describe, expect, test } from "bun:test"
import { Layer } from "effect"
import type { LanguageModel } from "effect/ai"
import { kernel } from "@xandreed/core/kernel"
import { settings } from "./contracts/loop/settings.adapter.js"
import type { Core, JournalStorage, Sessions } from "@xandreed/core/kernel"
import type { Loop } from "./contracts/loop/loop.port.js"
import type { Settings } from "./contracts/loop/settings.port.js"
import type { Memory } from "./contracts/memory/memory.port.js"
import { inbox, inProcessJournal, sessions, stepLoop, windowMemory } from "./index.js"
import type { Inbox, InvalidBudget } from "./index.js"

/*
 * A stack's type says what it provides and what it still needs, so a stack
 * whose type is written out does not compile when a part is missing: the
 * error lands on the line that annotates it.
 */

/** Everything an agent of the stock parts provides, needing nothing. */
type Agent = Layer.Layer<Inbox | Loop | Memory | Sessions | JournalStorage | Core | Settings | LanguageModel.LanguageModel, InvalidBudget>

const complete = (model: Layer.Layer<LanguageModel.LanguageModel>) => {
  const AgentLive: Agent = inbox.pipe(
    Layer.provideMerge(stepLoop),
    Layer.provideMerge(windowMemory({ budgetTokens: 3000 })),
    Layer.provideMerge(settings({ system: "You are a friendly tutor." })),
    Layer.provideMerge(sessions()),
    Layer.provideMerge(inProcessJournal()),
    Layer.provideMerge(kernel()),
    Layer.provideMerge(model),
  )
  return AgentLive
}

const withoutSessions = (model: Layer.Layer<LanguageModel.LanguageModel>) => {
  // @ts-expect-error the stack leaves out `sessions()`: it still needs `Sessions` and does not provide it
  const AgentLive: Agent = inbox.pipe(
    Layer.provideMerge(stepLoop),
    Layer.provideMerge(windowMemory({ budgetTokens: 3000 })),
    Layer.provideMerge(settings({ system: "You are a friendly tutor." })),
    Layer.provideMerge(inProcessJournal()),
    Layer.provideMerge(kernel()),
    Layer.provideMerge(model),
  )
  return AgentLive
}

const withoutTheModel = () => {
  // @ts-expect-error the stack leaves out the model: the loop still needs `LanguageModel`
  const AgentLive: Agent = inbox.pipe(
    Layer.provideMerge(stepLoop),
    Layer.provideMerge(windowMemory({ budgetTokens: 3000 })),
    Layer.provideMerge(settings({ system: "You are a friendly tutor." })),
    Layer.provideMerge(sessions()),
    Layer.provideMerge(inProcessJournal()),
    Layer.provideMerge(kernel()),
  )
  return AgentLive
}

const loopBelowItsMemory = (model: Layer.Layer<LanguageModel.LanguageModel>) => {
  // @ts-expect-error the loop is built before the memory it needs: what a layer needs is provided by the layers below it
  const AgentLive: Agent = inbox.pipe(
    Layer.provideMerge(windowMemory({ budgetTokens: 3000 })),
    Layer.provideMerge(stepLoop),
    Layer.provideMerge(settings({ system: "You are a friendly tutor." })),
    Layer.provideMerge(sessions()),
    Layer.provideMerge(inProcessJournal()),
    Layer.provideMerge(kernel()),
    Layer.provideMerge(model),
  )
  return AgentLive
}

describe("a stack of layers", () => {
  test("type-level: a stack missing a part, or with a part below what it needs, does not compile where its type is annotated", () => {
    // The checks are the compiler's: this file compiles only because each incomplete stack is an error, and the complete one is not.
    expect([complete, withoutSessions, withoutTheModel, loopBelowItsMemory]).toHaveLength(4)
  })
})
