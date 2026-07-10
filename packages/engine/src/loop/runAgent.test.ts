import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool, Toolkit } from "@effect/ai"
import { Effect, FiberRef, Layer, Option, Ref, Schema, Stream } from "effect"
import { Failure } from "../domain/Failure.js"
import { Checkpoint, ConversationId } from "../domain/Message.js"
import type { AgentMessage } from "../domain/Message.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { CurrentPromptCacheKey } from "./cacheKey.js"
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
      checkpointAt: (_id, summary, messagePosition) =>
        Ref.set(
          fold,
          Option.some(
            new Checkpoint({ conversationId: cid, messagePosition, summary, createdAt: 0 }),
          ),
        ),
      latestCheckpoint: () => Ref.get(fold),
      setTitle: () => Effect.void,
      listByWorkspace: () => Effect.succeed([]),
      fork: () => Effect.succeed(cid),
    prune: () => Effect.succeed(0),
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

  test("WITHIN-run compaction: past the threshold, checkpointAt covers the folded rows exactly", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* memoryStore
        const prompts: Array<string> = []
        const calls = yield* Ref.make(0)
        // Two tool turns then stop: keepTurns=1 needs a SECOND assistant
        // turn before a safe cut exists (the fold keeps one turn verbatim).
        const bigModel = LanguageModel.make({
          generateText: (options) =>
            Ref.getAndUpdate(calls, (n) => n + 1).pipe(
              Effect.tap((n) =>
                Effect.sync(() => {
                  prompts[n] = JSON.stringify(options.prompt.content)
                }),
              ),
              Effect.map(
                (n) =>
                  (n < 2
                    ? [
                        { type: "tool-call", id: `c${n}`, name: "noop", params: { value: "x" } },
                        {
                          type: "finish",
                          reason: "tool-calls",
                          usage: { inputTokens: 90_000, outputTokens: 5, totalTokens: 90_005 },
                        },
                      ]
                    : [
                        { type: "text", text: "done" },
                        {
                          type: "finish",
                          reason: "stop",
                          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                        },
                      ]) as never,
              ),
            ),
          streamText: () => Stream.die("not scripted") as never,
        })

        const result = yield* runAgent(
          {
            system: "sys",
            toolkit: emptyKit,
            compaction: {
              thresholdTokens: 50_000,
              keepTurns: 1,
              summarize: () => Effect.succeed("MID-RUN HANDOFF"),
            },
          },
          cid,
          "the big brief",
        ).pipe(
          Effect.provide(emptyHandlers),
          Effect.provideServiceEffect(LanguageModel.LanguageModel, bigModel),
          Effect.provide(store.layer),
        )
        expect(result.finalText).toBe("done")

        // Rows: prompt(0) a(1) t(2) a(3) t(4) a(5). The fold after turn 2
        // keeps the last assistant turn: checkpoint at position 2, listActive
        // returns exactly the kept rows.
        const persisted = yield* Effect.gen(function* () {
          const s = yield* ConversationStore
          const checkpoint = yield* s.latestCheckpoint(cid)
          const active = yield* s.listActive(cid)
          return { checkpoint, active }
        }).pipe(Effect.provide(store.layer))
        const checkpoint = Option.getOrThrow(persisted.checkpoint)
        expect(checkpoint.summary).toBe("MID-RUN HANDOFF")
        expect(checkpoint.messagePosition).toBe(2)
        expect(persisted.active.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"])
        // Call 3 ran on summary + kept tail, not the original brief.
        expect(prompts[2]).toContain("MID-RUN HANDOFF")
        expect(prompts[2]).not.toContain("the big brief")
      }),
    )
  })

  test("a failing summarizer skips the fold — the run continues on the full buffer", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* memoryStore
        const calls = yield* Ref.make(0)
        const prompts: Array<string> = []
        const bigModel = LanguageModel.make({
          generateText: (options) =>
            Ref.getAndUpdate(calls, (n) => n + 1).pipe(
              Effect.tap((n) =>
                Effect.sync(() => {
                  prompts[n] = JSON.stringify(options.prompt.content)
                }),
              ),
              Effect.map(
                (n) =>
                  (n < 2
                    ? [
                        { type: "tool-call", id: `c${n}`, name: "noop", params: { value: "x" } },
                        {
                          type: "finish",
                          reason: "tool-calls",
                          usage: { inputTokens: 90_000, outputTokens: 5, totalTokens: 90_005 },
                        },
                      ]
                    : [
                        { type: "text", text: "done" },
                        {
                          type: "finish",
                          reason: "stop",
                          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                        },
                      ]) as never,
              ),
            ),
          streamText: () => Stream.die("not scripted") as never,
        })
        const result = yield* runAgent(
          {
            system: "sys",
            toolkit: emptyKit,
            compaction: {
              thresholdTokens: 50_000,
              keepTurns: 1,
              summarize: () => Effect.fail("fast tier down"),
            },
          },
          cid,
          "the big brief",
        ).pipe(
          Effect.provide(emptyHandlers),
          Effect.provideServiceEffect(LanguageModel.LanguageModel, bigModel),
          Effect.provide(store.layer),
        )
        expect(result.finalText).toBe("done")
        const checkpoint = yield* Effect.gen(function* () {
          const s = yield* ConversationStore
          return yield* s.latestCheckpoint(cid)
        }).pipe(Effect.provide(store.layer))
        expect(Option.isNone(checkpoint)).toBe(true)
        expect(prompts[2]).toContain("the big brief")
      }),
    )
  })

  test("the run stamps CurrentPromptCacheKey with the conversation id for every call", async () => {
    const seen: Array<string> = []
    const spyModel = LanguageModel.make({
      generateText: () =>
        Effect.gen(function* () {
          const key = yield* FiberRef.get(CurrentPromptCacheKey)
          seen.push(Option.getOrElse(key, () => "(none)"))
          return [
            { type: "text", text: "ok" },
            {
              type: "finish",
              reason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ] as never
        }),
      streamText: () => Stream.die("not scripted") as never,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* memoryStore
        yield* runAgent({ system: "sys", toolkit: emptyKit }, cid, "hello").pipe(
          Effect.provide(emptyHandlers),
          Effect.provideServiceEffect(LanguageModel.LanguageModel, spyModel),
          Effect.provide(store.layer),
        )
      }),
    )
    expect(seen).toEqual([String(cid)])
  })
})
