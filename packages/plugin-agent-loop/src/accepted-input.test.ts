import { expect, test } from "bun:test"
import { AiError, LanguageModel, Tool, Toolkit } from "effect/ai"
import type { Response } from "effect/ai"
import { Effect, Option, Ref, Schema, Stream } from "effect"
import { parseModelSelection } from "@xandreed/core"
import type { AcceptedModelInput, AgentMessage } from "@xandreed/core"
import { runLoop } from "./loop.js"

const finish = (input: number, model?: string): Response.FinishPartEncoded => ({
  type: "finish", reason: "stop", usage: { inputTokens: { total: input }, outputTokens: { total: 2 } },
  ...(model === undefined ? {} : { metadata: { engine: { model } } }),
})
type Record = { readonly tail: ReadonlyArray<AgentMessage>; readonly accepted: Option.Option<AcceptedModelInput> }

test("stream fallback supplies only the accepted settled finish-only response's actual input and model", async () => {
  const observed = await Effect.runPromise(Effect.gen(function* () {
    const records = yield* Ref.make<ReadonlyArray<Record>>([])
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const model = yield* LanguageModel.make({
      generateText: () => Ref.update(calls, (all) => [...all, "settled"]).pipe(Effect.as([finish(150, "backup:actual")])),
      streamText: () => Stream.unwrap(Ref.update(calls, (all) => [...all, "stream"]).pipe(Effect.as(Stream.fail(AiError.make({
        module: "Fixture", method: "streamText", reason: new AiError.InternalProviderError({ description: "unavailable" }),
      }))))),
    })
    const result = yield* runLoop({
      system: "fixture", messages: [{ role: "user", content: "go" }], toolkit: Toolkit.make(), streaming: true,
      onTail: (tail, _step, accepted) => Ref.update(records, (all) => [...all, { tail, accepted: Option.fromNullishOr(accepted) }]).pipe(Effect.as([])),
    }).pipe(Effect.provideService(LanguageModel.LanguageModel, model))
    return { records: yield* Ref.get(records), calls: yield* Ref.get(calls), result }
  }))
  expect(observed.calls).toEqual(["stream", "settled"])
  expect(observed.result.newTail).toEqual([])
  expect(observed.records).toEqual([{ tail: [], accepted: Option.some({ model: parseModelSelection("backup:actual"), inputTokens: Option.some(150) }) }])
})

test("planned calls, results, nudges and nondurable steers omit evidence while an unusable accepted empty reply supplies it", async () => {
  const Probe = Tool.make("probe", { description: "Return a number.", parameters: Schema.Struct({ n: Schema.Number }), success: Schema.Number })
  const toolkit = Toolkit.make(Probe)
  const observed = await Effect.runPromise(Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const steered = yield* Ref.make(false)
    const records = yield* Ref.make<ReadonlyArray<Record>>([])
    const handlers = yield* toolkit.toHandlers({ probe: ({ n }) => Effect.succeed(n) })
    const model = yield* LanguageModel.make({
      generateText: () => Ref.getAndUpdate(calls, (count) => count + 1).pipe(Effect.map((count): Array<Response.PartEncoded> => count === 0
        ? [{ type: "tool-call", id: "actual", name: "probe", params: { n: 7 }, providerExecuted: false }, { ...finish(120, "actual:model"), reason: "tool-calls" }]
        : [finish(0)])),
      streamText: () => Stream.die("not scripted"),
    })
    yield* runLoop({
      system: "fixture", messages: [{ role: "user", content: "go" }], toolkit,
      initialStep: [{ name: "probe", params: { n: 7 } }],
      degenerate: { _tag: "Enabled", nudgeAfter: 1, breakAfter: 3 },
      pendingInput: () => Ref.getAndSet(steered, true).pipe(Effect.map((already) => already ? Option.none() : Option.some("additional host input"))),
      onTail: (tail, _step, accepted) => Ref.update(records, (all) => [...all, { tail, accepted: Option.fromNullishOr(accepted) }]).pipe(Effect.as([])),
    }).pipe(Effect.provide(handlers), Effect.provideService(LanguageModel.LanguageModel, model))
    return yield* Ref.get(records)
  }))
  const facts = observed.flatMap((record) => Option.toArray(record.accepted))
  expect(facts).toEqual([
    { model: parseModelSelection("actual:model"), inputTokens: Option.some(120) },
    { model: Option.none(), inputTokens: Option.none() },
  ])
  expect(observed[0]?.accepted).toEqual(Option.none())
  expect(observed.filter((record) => record.tail.some((message) => message.role === "user")).length).toBe(2)
  expect(observed.filter((record) => record.tail.some((message) => message.role === "user" || message.role === "tool")).every((record) => Option.isNone(record.accepted))).toBe(true)
  expect(observed.at(-1)).toEqual({ tail: [], accepted: Option.some({ model: Option.none(), inputTokens: Option.none() }) })
})
