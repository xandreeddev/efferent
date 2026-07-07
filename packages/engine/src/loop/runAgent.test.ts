import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool, Toolkit } from "@effect/ai"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { Failure } from "../domain/Failure.js"
import { Checkpoint, ConversationId } from "../domain/Message.js"
import type { AgentMessage } from "../domain/Message.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { runAgent } from "./runAgent.js"

const cid = ConversationId.make("00000000-0000-4000-8000-000000000002")

/** A tiny in-memory store honouring the position + fold contract. */
const memoryStore = Effect.gen(function* () {
  const rows = yield* Ref.make<ReadonlyArray<AgentMessage>>([])
  const fold = yield* Ref.make(Option.none<Checkpoint>())
  return {
    layer: Layer.succeed(ConversationStore, {
      create: () => Effect.succeed(cid),
      append: (_id, message) =>
        Ref.modify(rows, (all) => [all.length, [...all, message]] as const),
      list: () => Ref.get(rows),
      listActive: () =>
        Effect.gen(function* () {
          const checkpoint = yield* Ref.get(fold)
          const all = yield* Ref.get(rows)
          return Option.match(checkpoint, {
            onNone: () => all,
            onSome: (c) => all.slice(c.messagePosition + 1),
          })
        }),
      checkpoint: (_id, summary) =>
        Effect.gen(function* () {
          const all = yield* Ref.get(rows)
          yield* Ref.set(
            fold,
            Option.some(
              new Checkpoint({
                conversationId: cid,
                messagePosition: all.length - 1,
                summary,
                createdAt: 0,
              }),
            ),
          )
        }),
      latestCheckpoint: () => Ref.get(fold),
      setTitle: () => Effect.void,
      listByWorkspace: () => Effect.succeed([]),
    }),
    rows,
  }
})

const Noop = Tool.make("noop", {
  description: "does nothing",
  parameters: { value: Schema.String },
  success: Schema.Struct({ done: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
})
const emptyKit = Toolkit.make(Noop)
const emptyHandlers = emptyKit.toLayer({ noop: () => Effect.succeed({ done: true }) })

const textModel = (text: string) =>
  LanguageModel.make({
    generateText: () =>
      Effect.succeed([
        { type: "text", text },
        {
          type: "finish",
          reason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ] as never),
    streamText: () => Stream.die("not scripted") as never,
  })

describe("runAgent", () => {
  test("appends the user prompt + the tail with positions; loads prior history", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* memoryStore
        const result = yield* runAgent({ system: "sys", toolkit: emptyKit }, cid, "hello").pipe(
          Effect.provide(emptyHandlers),
          Effect.provideServiceEffect(LanguageModel.LanguageModel, textModel("world")),
          Effect.provide(store.layer),
        )
        expect(result.finalText).toBe("world")
        const persisted = yield* Ref.get(store.rows)
        expect(persisted.map((m) => m.role)).toEqual(["user", "assistant"])
      }),
    )
  })

  test("a checkpoint's summary is prepended to the loaded window as a handoff", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* memoryStore
        // Seed folded-away history + a checkpoint over it.
        yield* Effect.gen(function* () {
          const s = yield* ConversationStore
          yield* s.append(cid, { role: "user", content: "old stuff" })
          yield* s.checkpoint(cid, "WE AGREED ON THE PLAN")
        }).pipe(Effect.provide(store.layer))

        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        const spyModel = LanguageModel.make({
          generateText: (options) =>
            Ref.update(seen, () =>
              options.prompt.content.map((m) => JSON.stringify(m)),
            ).pipe(
              Effect.as([
                { type: "text", text: "ok" },
                {
                  type: "finish",
                  reason: "stop",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ] as never),
            ),
          streamText: () => Stream.die("not scripted") as never,
        })
        yield* runAgent({ system: "sys", toolkit: emptyKit }, cid, "next").pipe(
          Effect.provide(emptyHandlers),
          Effect.provideServiceEffect(LanguageModel.LanguageModel, spyModel),
          Effect.provide(store.layer),
        )
        const prompt = yield* Ref.get(seen)
        const joined = prompt.join("\n")
        expect(joined).toContain("WE AGREED ON THE PLAN")
        // The folded original is NOT re-fed.
        expect(joined).not.toContain("old stuff")
        expect(joined).toContain("next")
      }),
    )
  })
})
