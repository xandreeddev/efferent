import { describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Ref, Scope } from "effect"
import type { LanguageModel } from "effect/ai"
import { Core, inspectionOf, kernel, Memory, requestSentEvent, Sessions } from "@xandreed/core/kernel"
import type { SessionId, Settings } from "@xandreed/core/kernel"
import { Inbox, inbox, inProcessJournal, scriptedModel, sessions, stepLoop, windowMemory } from "./index.js"
import type { InvalidBudget } from "./index.js"

/*
 * Replacing a part while running: the base (the kernel, the journal and the
 * session plugin) is built once, and each stack above it in a scope of its
 * own; the old stack's scope is closed before the new one takes a turn.
 */

describe("a session over a shared base", () => {
  test("goes on under another memory: the old memory's listener hears nothing after the swap, and the session keeps its earlier messages", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, calls } = yield* scriptedModel([{ _tag: "Answers", pieces: ["Hi, Ana."] }, { _tag: "Answers", pieces: ["Ana."] }])
      const heard = yield* Ref.make<ReadonlyArray<string>>([])

      /** The kernel, a journal kept in the process and the session plugin, over the model: the part built once. */
      const Base = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel({ system: "You are a friendly tutor." })), Layer.provideMerge(model))
      /** A window memory with a listener of its own, which notes, under `name`, each request it hears of. */
      const noting = (name: string, budgetTokens: number): Layer.Layer<Memory, InvalidBudget, Core | Settings> => windowMemory({ budgetTokens }).pipe(
        Layer.provideMerge(Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(requestSentEvent, () => Ref.update(heard, (all) => [...all, name]), { name, wait: true })))),
      )
      /** The parts above the base: the inbox, the loop and a memory. */
      const Upper = (memory: Layer.Layer<Memory, InvalidBudget, Core | Settings>): Layer.Layer<Inbox, InvalidBudget, Core | Settings | Sessions | LanguageModel.LanguageModel> =>
        inbox.pipe(Layer.provideMerge(stepLoop), Layer.provideMerge(memory))
      /** Queue a message with a stack's inbox and wait for its reply. */
      const ask = (agent: Context.Context<Inbox>, session: SessionId, message: string) =>
        Effect.flatMap(Context.get(agent, Inbox).enqueue(session, message), (entry) => entry.reply)

      // #region swap
      const scope = yield* Effect.scope
      const base = yield* Layer.buildWithScope(Base, scope)        // kernel + journal + sessions, built once
      const session = yield* Context.get(base, Sessions).create({ owner: "learner" })

      const first  = yield* Scope.fork(scope)
      const agentA = yield* Layer.buildWithScope(Upper(noting("A", 200)), first).pipe(Effect.provide(base))
      const before = yield* ask(agentA, session, "Hi, I'm Ana.")

      yield* Scope.close(first, Exit.void)                           // the old stack's listeners are removed here
      const second = yield* Scope.fork(scope)
      const agentB = yield* Layer.buildWithScope(Upper(noting("B", 3000)), second).pipe(Effect.provide(base))
      const after  = yield* ask(agentB, session, "What's my name?")   // the same session goes on under the other memory
      // #endregion swap

      const inspection = yield* Effect.fromResult(inspectionOf(yield* Context.get(base, Sessions).read(session)))
      return { before, after, heard: yield* Ref.get(heard), calls: yield* calls, inspection }
    })))
    expect([result.before, result.after]).toEqual([{ text: "Hi, Ana." }, { text: "Ana." }])
    // The old memory heard its own turn's request and nothing after its stack was closed; the new one heard the next.
    expect(result.heard).toEqual(["A", "B"])
    // One journal: the second turn is the session's second, and its request is the new memory's, with the new budget.
    expect(result.inspection.state).toEqual({ _tag: "Free", turns: 2 })
    expect(result.inspection.requests.map((request) => Number(request.budgetTokens))).toEqual([200, 3000])
    // The session goes on with its earlier messages: the model is sent the first turn's, then the new one.
    expect(result.calls[1]?.map((message) => message.text)).toEqual(["You are a friendly tutor.", "Hi, I'm Ana.", "Hi, Ana.", "What's my name?"])
  })
})
