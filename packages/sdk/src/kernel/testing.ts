import { Effect, Layer, Ref, Stream } from "effect"
import type { Schema } from "effect"
import { AiError, LanguageModel } from "effect/ai"
import type { Prompt, Response } from "effect/ai"
import { Core, definePlugin } from "@xandreed/core/kernel"
import type { EventDefinition, KernelEvent } from "@xandreed/core/kernel"

/*
 * Scaffolding for the kernel's tests: scripted models (no provider, no
 * network) and a plugin that writes down what `Core` publishes.
 */

const usage = { inputTokens: { total: 12, uncached: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } }

/** A model's whole answer as a stream of parts: `pieces`, one text delta each. */
export const answer = (...pieces: ReadonlyArray<string>): Stream.Stream<Response.StreamPartEncoded> => Stream.fromIterable<Response.StreamPartEncoded>([
  { type: "text-start", id: "t" },
  ...pieces.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
  { type: "text-end", id: "t" },
  { type: "finish", reason: "stop", usage },
])

/** What a scripted model was sent, call by call: each message's role and text. */
export type Received = ReadonlyArray<ReadonlyArray<{ readonly role: string; readonly text: string }>>

const received = (prompt: Prompt.Prompt): Received[number] =>
  prompt.content.map((message) => ({
    role: message.role,
    text: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join(""),
  }))

/** A model that answers call `n` (from 0) with `answerOf(n)`, as a layer, with what it was sent. */
export const scripted = (answerOf: (call: number) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>) => Effect.gen(function* () {
  const prompts = yield* Ref.make<Received>([])
  const model = yield* LanguageModel.make({
    generateText: () => Effect.die("the scripted model only streams"),
    streamText: (options) => Stream.unwrap(Ref.modify(prompts, (all) => [answerOf(all.length), [...all, received(options.prompt)]] as const)),
  })
  return { model: Layer.succeed(LanguageModel.LanguageModel, model), received: Ref.get(prompts) }
})

/** A model that streams `pieces` as its answer to every call. */
export const answering = (...pieces: ReadonlyArray<string>) => scripted(() => answer(...pieces))

/** A model that answers call `n` (from 0) with `Reply n+1.`. */
export const counting = scripted((call) => answer(`Reply ${call + 1}.`))

/** The error of a model that is down. */
export const modelDown = AiError.make({ module: "Scripted", method: "streamText", reason: new AiError.UnknownError({ description: "the scripted model is down" }) })

/**
 * An extra plugin that writes down, in order, every event of the given
 * definitions as `Core` publishes it. It waits, so what it has seen when
 * `send` returns is everything published during the turn.
 */
export const recording = (definitions: ReadonlyArray<EventDefinition<Schema.Json>>) => Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<KernelEvent>>([])
  const plugin = definePlugin({
    name: "recorder",
    make: Effect.gen(function* () {
      const core = yield* Core
      yield* Effect.forEach(definitions, (definition) =>
        core.on(definition, (event) => Ref.update(seen, (all) => [...all, event]), { wait: true }), { concurrency: 1, discard: true })
    }),
  })
  return { plugin, seen: Ref.get(seen), names: Effect.map(Ref.get(seen), (all) => all.map((event): string => event.name)) }
})
