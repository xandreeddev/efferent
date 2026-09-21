import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool, Toolkit } from "@effect/ai"
import { Effect, FiberRef, Layer, Option, Ref, Schema, Stream } from "effect"
import { Failure } from "@xandreed/core"
import { Checkpoint, ConversationId } from "@xandreed/core"
import type { AgentMessage } from "@xandreed/core"
import { ConversationStore, StoredMessage } from "@xandreed/core"
import { CurrentPromptCacheKey } from "@xandreed/core"
import { runAgent } from "./runAgent.js"

const cid = ConversationId.make("00000000-0000-4000-8000-000000000002")

/** A tiny in-memory store honouring the position + fold contract. */
const memoryStore = Effect.gen(function* () {
  const rows = yield* Ref.make<ReadonlyArray<AgentMessage>>([])
  const fold = yield* Ref.make(Option.none<Checkpoint>())
  // Every write as the store saw it — `appendAll` batches are one entry.
  const writes = yield* Ref.make<ReadonlyArray<ReadonlyArray<AgentMessage>>>([])
  const outcomes = yield* Ref.make<ReadonlyArray<string>>([])
  return {
    layer: Layer.succeed(ConversationStore, {
      create: () => Effect.succeed(cid),
      append: (_id, message) =>
        Ref.update(writes, (all) => [...all, [message]]).pipe(
          Effect.zipRight(Ref.modify(rows, (all) => [all.length, [...all, message]] as const)),
        ),
      appendAll: (_id, messages) =>
        Ref.update(writes, (all) => [...all, messages]).pipe(
          Effect.zipRight(
            Ref.modify(rows, (all) => [
              messages.map((_, i) => all.length + i),
              [...all, ...messages],
            ] as const),
          ),
        ),
      list: () => Ref.get(rows),
      listActive: () =>
        Effect.gen(function* () {
          const checkpoint = yield* Ref.get(fold)
          const all = yield* Ref.get(rows)
          const positioned = all.map((message, position) => new StoredMessage({ position, message }))
          return Option.match(checkpoint, {
            onNone: () => positioned,
            onSome: (c) => positioned.slice(c.messagePosition + 1),
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
      recordOutcome: (_id, outcome, reason) =>
        Ref.update(outcomes, (all) => [...all, `${outcome}:${reason}`]),
      latestOutcome: () => Effect.succeed(Option.none()),
      listByWorkspace: () => Effect.succeed([]),
      fork: () => Effect.succeed(cid),
    prune: () => Effect.succeed(0),
    }),
    rows,
    writes,
    outcomes,
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
        expect(persisted.active.map((row) => row.message.role)).toEqual(["assistant", "tool", "assistant"])
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

describe("runAgent — persistence that survives an interrupt", () => {
  test("a tool turn's assistant call and its results land as ONE write; the prompt alone is its own", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* memoryStore
        const calls = yield* Ref.make(0)
        const toolThenText = LanguageModel.make({
          generateText: () =>
            Ref.getAndUpdate(calls, (n) => n + 1).pipe(
              Effect.map(
                (n) =>
                  (n === 0
                    ? [
                        { type: "tool-call", id: "c0", name: "noop", params: { value: "x" } },
                        {
                          type: "finish",
                          reason: "tool-calls",
                          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                        },
                      ]
                    : [
                        { type: "text", text: "done" },
                        {
                          type: "finish",
                          reason: "stop",
                          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                        },
                      ]) as never,
              ),
            ),
          streamText: () => Stream.die("not scripted") as never,
        })
        yield* runAgent({ system: "sys", toolkit: emptyKit }, cid, "go").pipe(
          Effect.provide(emptyHandlers),
          Effect.provideServiceEffect(LanguageModel.LanguageModel, toolThenText),
          Effect.provide(store.layer),
        )
        const writes = yield* Ref.get(store.writes)
        expect(writes.map((batch) => batch.map((m) => m.role))).toEqual([
          ["user"],
          ["assistant", "tool"],
          ["assistant"],
        ])
      }),
    )
  })

  test("the compaction mirror reads positions OFF the rows — a gap in the stored positions does not shift the checkpoint", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // A store whose active window has a HOLE (an undecodable row at 2
        // was skipped): real positions 0, 1, 3, then the prompt at 4; the old
        // arithmetic (prompt − length + 1 + index) read them as 1, 2, 3, 4.
        const rows = yield* Ref.make<ReadonlyArray<{ position: number; message: AgentMessage }>>([
          { position: 0, message: { role: "user", content: "old question" } },
          { position: 1, message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } },
          { position: 3, message: { role: "assistant", content: [{ type: "text", text: "old follow-up" }] } },
        ])
        const fold = yield* Ref.make(Option.none<Checkpoint>())
        const layer = Layer.succeed(ConversationStore, {
          create: () => Effect.succeed(cid),
          append: (_id, message) =>
            Ref.modify(rows, (all) => {
              const position = (all[all.length - 1]?.position ?? -1) + 1
              return [position, [...all, { position, message }]] as const
            }),
          appendAll: (_id, messages) =>
            Ref.modify(rows, (all) => {
              const base = (all[all.length - 1]?.position ?? -1) + 1
              const added = messages.map((message, i) => ({ position: base + i, message }))
              return [added.map((r) => r.position), [...all, ...added]] as const
            }),
          list: () => Effect.map(Ref.get(rows), (all) => all.map((r) => r.message)),
          listActive: () =>
            Effect.map(Ref.get(rows), (all) => all.map((r) => new StoredMessage(r))),
          checkpoint: () => Effect.void,
          checkpointAt: (_id, summary, messagePosition) =>
            Ref.set(fold, Option.some(new Checkpoint({ conversationId: cid, messagePosition, summary, createdAt: 0 }))),
          latestCheckpoint: () => Ref.get(fold),
          setTitle: () => Effect.void,
          recordOutcome: () => Effect.void,
          latestOutcome: () => Effect.succeed(Option.none()),
          listByWorkspace: () => Effect.succeed([]),
          fork: () => Effect.succeed(cid),
          prune: () => Effect.succeed(0),
        })
        const calls = yield* Ref.make(0)
        const bigModel = LanguageModel.make({
          generateText: () =>
            Ref.getAndUpdate(calls, (n) => n + 1).pipe(
              Effect.map(
                (n) =>
                  (n < 2
                    ? [
                        { type: "tool-call", id: `c${n}`, name: "noop", params: { value: "x" } },
                        { type: "finish", reason: "tool-calls", usage: { inputTokens: 90_000, outputTokens: 5, totalTokens: 90_005 } },
                      ]
                    : [
                        { type: "text", text: "done" },
                        { type: "finish", reason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
                      ]) as never,
              ),
            ),
          streamText: () => Stream.die("not scripted") as never,
        })
        yield* runAgent(
          {
            system: "sys",
            toolkit: emptyKit,
            compaction: { thresholdTokens: 50_000, keepTurns: 2, summarize: () => Effect.succeed("FOLD") },
          },
          cid,
          "the prompt",
        ).pipe(
          Effect.provide(emptyHandlers),
          Effect.provideServiceEffect(LanguageModel.LanguageModel, bigModel),
          Effect.provide(layer),
        )
        // Buffer after turn 0: old question(0) · old answer(1) · old
        // follow-up(3) · prompt(4) · a(5) · t(6). keepTurns=2 keeps from
        // "old follow-up" → the fold covers through "old answer" at position
        // 1. Arithmetic would have written 2 — the hole — as the covered
        // position, one row past the truth.
        const checkpoint = Option.getOrThrow(yield* Ref.get(fold))
        expect(checkpoint.messagePosition).toBe(1)
      }),
    )
  })
})

describe("runAgent — the outcome goes beside the trail", () => {
  test("a completed run records ok/completed; a capped run records partial/step-cap", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* memoryStore
        yield* runAgent({ system: "sys", toolkit: emptyKit }, cid, "hello").pipe(
          Effect.provide(emptyHandlers),
          Effect.provideServiceEffect(LanguageModel.LanguageModel, textModel("world")),
          Effect.provide(store.layer),
        )
        const alwaysTools = LanguageModel.make({
          generateText: () =>
            Effect.succeed([
              { type: "tool-call", id: "c", name: "noop", params: { value: "x" } },
              { type: "finish", reason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ] as never),
          streamText: () => Stream.die("not scripted") as never,
        })
        yield* runAgent({ system: "sys", toolkit: emptyKit, maxSteps: 2 }, cid, "loop").pipe(
          Effect.provide(emptyHandlers),
          Effect.provideServiceEffect(LanguageModel.LanguageModel, alwaysTools),
          Effect.provide(store.layer),
        )
        expect(yield* Ref.get(store.outcomes)).toEqual(["ok:completed", "partial:step-cap"])
      }),
    )
  })
})
