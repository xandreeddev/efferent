import { describe, expect, test } from "bun:test"
import { Effect, Exit, Option, Ref, Result, Stream } from "effect"
import { AiError, LanguageModel } from "effect/ai"
import type { Prompt, Response } from "effect/ai"
import { beginTurn, ContextError, ContextManager, endTurn, Events, messageOf, Seq, SessionId, Sessions, Tokens } from "@xandreed/core/kernel"
import type { Agent, LiveEvent, SessionRefused, SessionState, StoredEvent, TurnOpen } from "@xandreed/core/kernel"
import { runTurn } from "./run-turn.usecase.js"
import { runSteps } from "./step-loop.usecase.js"

/*
 * The frame and the default loop over ports written here: sessions that keep
 * one journal in memory under the kernel's own transitions, a context
 * manager that sends every message, and events gathered in a list. The model
 * is scripted.
 */

const usage = { inputTokens: { total: 12, uncached: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } }

/** A model that streams `pieces` as its answer; `prompts` is what it was sent. */
const scripted = (pieces: ReadonlyArray<string>) => Effect.gen(function* () {
  const prompts = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])
  const model = yield* LanguageModel.make({
    generateText: () => Effect.die("the scripted model only streams"),
    streamText: (options) => Stream.unwrap(Ref.update(prompts, (all) => [...all, options.prompt]).pipe(Effect.as(Stream.fromIterable<Response.StreamPartEncoded>([
      { type: "text-start", id: "t" },
      ...pieces.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
      { type: "text-end", id: "t" },
      { type: "finish", reason: "stop", usage },
    ])))),
  })
  return { model, prompts: Ref.get(prompts) }
})

/** A model whose every call fails. */
const failing = LanguageModel.make({
  generateText: () => Effect.die("the scripted model only streams"),
  streamText: () => Stream.fail(AiError.make({ module: "Scripted", method: "streamText", reason: new AiError.UnknownError({ description: "the scripted model is down" }) })),
})

/** What a transition decided: its answer, and the state after it. */
type Moved<A> = readonly [Effect.Effect<A, SessionRefused>, SessionState]

/** An agent over one session kept in memory, with what it stored and what it published. */
const agentOver = (model: LanguageModel.LanguageModel, budgetTokens = 3000) => Effect.gen(function* () {
  const journal = yield* Ref.make<ReadonlyArray<StoredEvent>>([])
  const state = yield* Ref.make<SessionState>({ _tag: "Free", turns: 0 })
  const published = yield* Ref.make<ReadonlyArray<LiveEvent>>([])
  const sessions = Sessions.of({
    open: (id) => Ref.modify(state, (now) => Result.match(beginTurn(now), {
      onFailure: (refusal): Moved<TurnOpen> => [Effect.fail(refusal), now],
      onSuccess: (opened): Moved<TurnOpen> => [Effect.succeed(opened), opened],
    })).pipe(Effect.flatten, Effect.map((opened) => ({
      id,
      turn: opened.turn,
      journal: Ref.get(journal),
      record: (event) => Ref.modify(journal, (events) => {
        const stored: StoredEvent = { seq: Seq.make(events.length + 1), at: 1_767_225_600_000, name: event.name, data: event.data }
        return [stored, [...events, stored]] as const
      }),
    }))),
    close: () => Ref.modify(state, (now) => Result.match(endTurn(now), {
      onFailure: (refusal): Moved<void> => [Effect.fail(refusal), now],
      onSuccess: (closed): Moved<void> => [Effect.void, closed],
    })).pipe(Effect.flatten),
  })
  const context = ContextManager.of({
    open: (session) => Effect.succeed({
      build: () => session.journal.pipe(
        Effect.map((events) => ({ messages: events.filter((event) => Option.isSome(messageOf(event))).map((event) => event.seq), records: [] })),
        Effect.mapError((error) => new ContextError({ reason: "BuildFailed", message: error.message })),
      ),
    }),
  })
  const events = Events.of({ publish: (event) => Ref.update(published, (all) => [...all, event]) })
  const agent: Agent = { model, system: "You are a friendly tutor.", limits: { budgetTokens: Tokens.make(budgetTokens) }, sessions, context, events, loop: runSteps }
  return {
    agent,
    stored: Ref.get(journal),
    published: Ref.get(published),
    state: Ref.get(state),
  }
})

const session = SessionId.make("session-1")
const names = (events: ReadonlyArray<{ readonly name: string }>) => events.map((event) => event.name)

describe("one turn of the kernel", () => {
  test("records the turn in order, streams the answer live and returns the reply", async () => {
    const run = await Effect.runPromise(Effect.gen(function* () {
      const { model, prompts } = yield* scripted(["Hel", "lo!"])
      const kernel = yield* agentOver(model)
      const reply = yield* runTurn(kernel.agent, { session, message: "Hello" })
      return { reply, stored: yield* kernel.stored, published: yield* kernel.published, state: yield* kernel.state, prompts: yield* prompts }
    }))
    expect(run.reply).toEqual({ text: "Hello!" })
    expect(names(run.stored)).toEqual(["core.turn.started", "core.user.message", "core.request.sent", "core.assistant.message", "core.turn.ended"])
    expect(run.stored.map((event): number => event.seq)).toEqual([1, 2, 3, 4, 5])
    expect(run.published.map((event) => `${event._tag} ${event.name}`)).toEqual([
      "Recorded core.turn.started",
      "Recorded core.user.message",
      "Recorded core.request.sent",
      "Emitted core.assistant.delta",
      "Emitted core.assistant.delta",
      "Recorded core.assistant.message",
      "Recorded core.turn.ended",
    ])
    expect(run.published.every((event) => event.session === session && event.turn === 1)).toBe(true)
    // The request is stored as places in the journal, and the model was sent the messages at those places.
    expect(run.stored[2]?.data).toEqual({ step: 1, system: "You are a friendly tutor.", messages: [2], estimatedTokens: 9, budgetTokens: 3000 })
    expect(run.prompts.map((prompt) => prompt.content.map((message) => message.role))).toEqual([["system", "user"]])
    expect(JSON.stringify(run.prompts[0]?.content)).toContain("Hello")
    expect(run.stored[4]?.data).toEqual({ outcome: { _tag: "Completed", reply: { text: "Hello!" } } })
    expect(run.state).toEqual({ _tag: "Free", turns: 1 })
  })

  test("a failing model still closes the turn, and the session takes the next one", async () => {
    const run = await Effect.runPromise(Effect.gen(function* () {
      const kernel = yield* agentOver(yield* failing)
      const failed = yield* Effect.exit(runTurn(kernel.agent, { session, message: "Hello" }))
      const afterFailure = { stored: yield* kernel.stored, state: yield* kernel.state }
      const { model } = yield* scripted(["Back."])
      const reply = yield* runTurn({ ...kernel.agent, model }, { session, message: "Again" })
      return { failed, afterFailure, reply, stored: yield* kernel.stored, state: yield* kernel.state }
    }))
    expect(Exit.isFailure(run.failed)).toBe(true)
    expect(names(run.afterFailure.stored)).toEqual(["core.turn.started", "core.user.message", "core.request.sent", "core.turn.ended"])
    expect(run.afterFailure.stored[3]?.data).toMatchObject({ outcome: { _tag: "Failed" } })
    expect(JSON.stringify(run.afterFailure.stored[3]?.data)).toContain("AiError")
    expect(run.afterFailure.state).toEqual({ _tag: "Free", turns: 1 })
    expect(run.reply).toEqual({ text: "Back." })
    expect(names(run.stored).slice(4)).toEqual(["core.turn.started", "core.user.message", "core.request.sent", "core.assistant.message", "core.turn.ended"])
    expect(run.state).toEqual({ _tag: "Free", turns: 2 })
  })

  test("a request over the budget is refused by its type before the model is called, and the turn still closes", async () => {
    const run = await Effect.runPromise(Effect.gen(function* () {
      const { model, prompts } = yield* scripted(["Hi."])
      const kernel = yield* agentOver(model, 8)
      const refused = yield* Effect.flip(runTurn(kernel.agent, { session, message: "Hello" }))
      return { refused, stored: yield* kernel.stored, state: yield* kernel.state, prompts: yield* prompts }
    }))
    expect(run.refused).toMatchObject({ _tag: "RequestRefused", reason: "OverBudget", estimatedTokens: 9, budgetTokens: 8 })
    expect(run.prompts).toEqual([])
    expect(names(run.stored)).toEqual(["core.turn.started", "core.user.message", "core.turn.ended"])
    expect(run.stored[2]?.data).toMatchObject({ outcome: { _tag: "Failed" } })
    expect(run.state).toEqual({ _tag: "Free", turns: 1 })
  })

  test("a session with a turn open refuses another, and nothing is recorded for it", async () => {
    const run = await Effect.runPromise(Effect.gen(function* () {
      const { model } = yield* scripted(["Hi."])
      const kernel = yield* agentOver(model)
      yield* kernel.agent.sessions.open(session)
      const refused = yield* Effect.flip(runTurn(kernel.agent, { session, message: "Hello" }))
      return { refused, stored: yield* kernel.stored }
    }))
    expect(run.refused).toMatchObject({ _tag: "SessionRefused", reason: "SessionBusy" })
    expect(run.stored).toEqual([])
  })
})
