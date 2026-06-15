import { describe, expect, it } from "bun:test"
import { LanguageModel } from "@effect/ai"
import { Effect, Layer, Ref, Schema } from "effect"
import { ConversationId, type AgentMessage } from "../entities/Conversation.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { createHandoff } from "./handoff.js"

const CID = Schema.decodeUnknownSync(ConversationId)("3f2f0c4e-9c1a-4b9e-8d2e-2a6f1b7c5d40")

/**
 * Ref-based ConversationStore stub mirroring the real fold semantics for one
 * conversation: append assigns position = max+1, checkpoint records at the
 * current max position, listActive returns only rows past the latest fold.
 */
const makeStoreStub = Effect.gen(function* () {
  const rows = yield* Ref.make<Array<{ position: number; message: AgentMessage }>>([])
  const checkpoints = yield* Ref.make<Array<{ messagePosition: number; summary: string }>>([])

  const append = (message: AgentMessage) =>
    Ref.update(rows, (rs) => [
      ...rs,
      { position: rs.length === 0 ? 0 : rs[rs.length - 1]!.position + 1, message },
    ])

  const store = ConversationStore.of({
    create: () => Effect.die("unused"),
    ensure: () => Effect.die("unused"),
    append: (_id: ConversationId, message: AgentMessage) => append(message),
    list: () => Ref.get(rows).pipe(Effect.map((rs) => rs.map((r) => r.message))),
    checkpoint: (_id: ConversationId, summary: string) =>
      Effect.gen(function* () {
        const rs = yield* Ref.get(rows)
        const head = rs.length === 0 ? -1 : rs[rs.length - 1]!.position
        yield* Ref.update(checkpoints, (cs) => [...cs, { messagePosition: head, summary }])
      }),
    getLatestCheckpoint: () =>
      Ref.get(checkpoints).pipe(Effect.map((cs) => cs[cs.length - 1])),
    listCheckpoints: () => Ref.get(checkpoints) as never,
    listActive: () =>
      Effect.gen(function* () {
        const cs = yield* Ref.get(checkpoints)
        const cutoff = cs.length === 0 ? -1 : cs[cs.length - 1]!.messagePosition
        const rs = yield* Ref.get(rows)
        return rs.filter((r) => r.position > cutoff).map((r) => r.message)
      }),
    setTitle: () => Effect.die("unused"),
    listByWorkspace: () => Effect.die("unused"),
  } as never)

  return {
    layer: Layer.succeed(ConversationStore, store),
    append,
    checkpoints: () => Ref.get(checkpoints),
  }
})

/** Capturing LanguageModel: records each prompt, replies from a script. */
const capturingModel = (replies: ReadonlyArray<string>) => {
  const prompts: string[] = []
  let calls = 0
  const service = {
    generateText: (options: { prompt: unknown }) => {
      prompts.push(JSON.stringify(options.prompt))
      const text = replies[Math.min(calls, replies.length - 1)] ?? ""
      calls++
      return Effect.succeed({ content: [], text, finishReason: "stop", usage: undefined })
    },
    generateObject: () => Effect.die("unused"),
    streamText: () => Effect.die("unused"),
  }
  return {
    model: LanguageModel.LanguageModel.of(service as never),
    prompts,
    calls: () => calls,
  }
}

describe("createHandoff", () => {
  it("folds the loaded view, is cumulative across folds, and no-ops when nothing is new", async () => {
    const { model, prompts, calls } = capturingModel(["S1", "S2"])
    await Effect.runPromise(
      Effect.gen(function* () {
        const stub = yield* makeStoreStub

        // Seed: one full turn incl. a tool call + result.
        yield* stub.append({ role: "user", content: "hello" })
        yield* stub.append({
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a" } },
          ],
        } as AgentMessage)
        yield* stub.append({
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "c1", toolName: "read_file", output: { content: "x" } },
          ],
        } as AgentMessage)

        // First fold: summarizes the transcript of the loaded view.
        yield* createHandoff(CID).pipe(Effect.provide(stub.layer))
        const p1 = prompts[0]!
        expect(p1).toContain("<transcript>")
        expect(p1).toContain("USER: hello")
        expect(p1).toContain("let me check")
        expect(p1).toContain("[called read_file]")
        expect(p1).toContain("TOOL RESULTS: read_file: ok")
        const cps1 = yield* stub.checkpoints()
        expect(cps1).toEqual([{ messagePosition: 2, summary: "S1" }])

        // Second fold: the prior summary is folded back in (cumulative);
        // the pre-fold messages are NOT in the new view.
        yield* stub.append({ role: "user", content: "now refactor it" })
        yield* createHandoff(CID).pipe(Effect.provide(stub.layer))
        const p2 = prompts[1]!
        expect(p2).toContain("S1")
        expect(p2).toContain("[System note:")
        expect(p2).toContain("now refactor it")
        expect(p2).not.toContain("USER: hello")
        const cps2 = yield* stub.checkpoints()
        expect(cps2.length).toBe(2)
        expect(cps2[1]).toEqual({ messagePosition: 3, summary: "S2" })

        // Third run immediately after: nothing new → no model call, no checkpoint.
        yield* createHandoff(CID).pipe(Effect.provide(stub.layer))
        expect(calls()).toBe(2)
        expect((yield* stub.checkpoints()).length).toBe(2)
      }).pipe(Effect.provideService(LanguageModel.LanguageModel, model)) as Effect.Effect<
        void,
        unknown,
        never
      >,
    )
  })
})
