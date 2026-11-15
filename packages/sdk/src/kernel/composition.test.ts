import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import type { LanguageModel } from "effect/ai"
import { kernel } from "@xandreed/core/kernel"
import type { Core, JournalStorage, OpenSession, Sessions } from "@xandreed/core/kernel"
import type { Memory } from "./contracts/memory/memory.port.js"
import { Approval, approve, callTool, CurrentTurn, inbox, inProcessJournal, sessions, windowMemory } from "./index.js"
import type { Inbox, InvalidBudget, ToolNeeds } from "./index.js"
import { runningTurn } from "./contracts/turn/running-turn.entity.functions.js"
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

/*
 * What a tool declares in `dependencies` is held by the compiler in three places: its handler may read nothing
 * else; a call of it through the toolkit needs each one; and a call through `callTool` needs each but the turn,
 * which `callTool` gives. A program that leaves one out does not compile where the type of what it runs is
 * written out.
 */
const Asks = Tool.make("asks", { success: Schema.String, failure: Schema.String, failureMode: "return", dependencies: [Approval, CurrentTurn] })
const Plain = Tool.make("plain", { success: Schema.String, failure: Schema.String, failureMode: "return" })
const askingTools = Toolkit.make(Asks, Plain)
const askingLive = askingTools.toLayer({
  asks: () => Effect.as(approve({ action: "act", detail: "Act." }), "done"),
  plain: () => Effect.succeed("done"),
})

/** A handler may read only what its tool declares: `plain` declares nothing, so asking in it is refused. */
const undeclared = () => askingTools.toLayer({
  asks: () => Effect.as(approve({ action: "act", detail: "Act." }), "done"),
  // @ts-expect-error `plain` declares neither `Approval` nor `CurrentTurn`: its handler cannot ask
  plain: () => Effect.as(approve({ action: "act", detail: "Act." }), "done"),
})

/** What the toolkit's calls need of the program: who a tool asks, and nothing of the turn. Neither is `any`. */
type IsAny<T> = 0 extends (1 & T) ? true : false
type Same<A, B> = IsAny<A> extends true ? false : [A] extends [B] ? ([B] extends [A] ? true : false) : false
const needsApproval: Same<ToolNeeds<typeof askingTools.tools>, Approval> = true
const plainTools = Toolkit.make(Plain)
const needsNothing: Same<ToolNeeds<typeof plainTools.tools>, never> = true
/** A tool typed `Tool.Any` has lost what it declares: a toolkit that holds one needs anything at all. */
const widenedIsAny: IsAny<ToolNeeds<Record<string, Tool.Any>>> = true
const namedIsAny: IsAny<ToolNeeds<{ readonly asks: Tool.Any }>> = true
const mixedIsAny: IsAny<ToolNeeds<{ readonly asks: typeof Asks; readonly other: Tool.Any }>> = true

/** So `callTool` refuses such a toolkit where it is passed: each tool's own type is what holds the dependencies. */
const widened = (session: OpenSession, toolkit: Toolkit.WithHandler<Record<string, Tool.Any>>) =>
  // @ts-expect-error a toolkit typed Record<string, Tool.Any> has lost what its tools declare
  callTool(toolkit, { id: "c1", name: "asks", params: {} }, session)

/** A name of its own does not save it: the tool under the name is still any tool. */
const named = (session: OpenSession, toolkit: Toolkit.WithHandler<{ readonly asks: Tool.Any }>) =>
  // @ts-expect-error a tool typed Tool.Any under its own name has lost what it declares
  callTool(toolkit, { id: "c1", name: "asks", params: {} }, session)

/** One such tool among a toolkit's own is enough: what the others declare is lost with it. */
const mixed = (session: OpenSession, toolkit: Toolkit.WithHandler<{ readonly asks: typeof Asks; readonly other: Tool.Any }>) =>
  // @ts-expect-error one tool typed Tool.Any among the toolkit's own loses what every tool declares
  callTool(toolkit, { id: "c1", name: "asks", params: {} }, session)

/** A toolkit with no tool needs nothing, and is taken. */
const none = (session: OpenSession) => {
  const call: Effect.Effect<unknown, unknown> = Effect.flatMap(Toolkit.make(), (toolkit) => callTool(toolkit, { id: "c1", name: "asks", params: {} }, session))
  return call
}

/** One call of the toolkit, as a loop runs it: `callTool` gives it its turn, and it still needs who a tool asks. */
const asking = (session: OpenSession) => Effect.flatMap(askingTools, (toolkit) => callTool(toolkit, { id: "c1", name: "asks", params: {} }, session))

const withApproval = (session: OpenSession, person: Layer.Layer<Approval>) => {
  const call: Effect.Effect<unknown, unknown> = asking(session).pipe(Effect.provide(Layer.merge(askingLive, person)))
  return call
}

const withoutApproval = (session: OpenSession) => {
  // @ts-expect-error a call of a toolkit with a tool that asks still needs `Approval`: nothing here provides it
  const call: Effect.Effect<unknown, unknown> = asking(session).pipe(Effect.provide(askingLive))
  return call
}

/** The toolkit's own `handle`, by a tool's name: it needs everything that tool declares, the turn included. */
const byHand = (person: Layer.Layer<Approval>) => {
  // @ts-expect-error `asks` declares `CurrentTurn`: a call by hand that gives it no turn does not compile
  const call: Effect.Effect<unknown, unknown> = Effect.flatMap(askingTools, (toolkit) => toolkit.handle("asks", {})).pipe(Effect.provide(Layer.merge(askingLive, person)))
  return call
}

/** The same call with its turn given compiles: the error above is the missing turn, and nothing else. */
const byHandInItsTurn = (session: OpenSession, person: Layer.Layer<Approval>) => {
  const call: Effect.Effect<unknown, unknown> = Effect.flatMap(askingTools, (toolkit) => toolkit.handle("asks", {})).pipe(
    Effect.provideService(CurrentTurn, runningTurn(session)),
    Effect.provide(Layer.merge(askingLive, person)),
  )
  return call
}

describe("a stack of layers", () => {
  test("type-level: a stack missing a part, or with a part below what it needs, does not compile where its type is annotated", () => {
    // The checks are the compiler's: this file compiles only because each incomplete stack is an error, and the complete one is not.
    expect([complete, withoutSessions, withoutTheModel, sessionsBelowTheJournal]).toHaveLength(4)
  })

  test("type-level: what a tool declares is held where its handler is written, where it is called by hand and where callTool runs it", () => {
    expect([withApproval, withoutApproval, undeclared, byHand, byHandInItsTurn, widened, named, mixed, none]).toHaveLength(9)
    expect([needsApproval, needsNothing, widenedIsAny, namedIsAny, mixedIsAny]).toEqual([true, true, true, true, true])
  })
})
