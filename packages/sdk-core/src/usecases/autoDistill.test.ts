import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import type { AgentMessage, ConversationId } from "../entities/Conversation.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { FileSystem } from "../ports/FileSystem.js"
import { UtilityLlm } from "../ports/UtilityLlm.js"
import { Verifier } from "../ports/Verifier.js"
import { runAutoDistill, AUTO_DISTILL_MIN_MESSAGES } from "./autoDistill.js"

const convStore = (messages: ReadonlyArray<AgentMessage>) =>
  Layer.succeed(ConversationStore, { list: () => Effect.succeed(messages) } as never)

// Empty tree → the deterministic efficiency gate finds no over-research (it must
// not fire here; we're testing the LLM-distiller guard).
const emptyTree = Layer.succeed(ContextTreeStore, {
  listTree: () => Effect.succeed([]),
} as never)

// If anything downstream of the guard runs, these die loudly — the test asserts
// the short-conversation guard short-circuits BEFORE the miner/gate/FS are touched.
const minerDies = Layer.succeed(UtilityLlm, {
  complete: () => Effect.die("miner must not run for a short conversation"),
})
const verifierDies = Layer.succeed(Verifier, {
  refute: () => Effect.die("verifier must not run"),
  gate: () => Effect.die("verifier must not run"),
} as never)
const fsDies = Layer.succeed(FileSystem, {
  write: () => Effect.die("fs must not run"),
} as never)

const cid = "c" as unknown as ConversationId

const run = (messages: ReadonlyArray<AgentMessage>) =>
  Effect.runPromise(
    runAutoDistill({ conversationId: cid, repoDir: "/r", existing: [] }).pipe(
      Effect.provide(
        Layer.mergeAll(convStore(messages), emptyTree, minerDies, verifierDies, fsDies),
      ),
    ),
  )

const msgs = (n: number): ReadonlyArray<AgentMessage> =>
  Array.from({ length: n }, (_, i) => ({ role: "user" as const, content: `m${i}` }))

describe("runAutoDistill — turn-boundary learn step", () => {
  it("skips a too-short conversation without invoking the miner/gate", async () => {
    const out = await run(msgs(AUTO_DISTILL_MIN_MESSAGES - 1))
    expect(out).toEqual([])
  })

  it("fail-soft: a store error yields [], never throws", async () => {
    const out = await Effect.runPromise(
      runAutoDistill({ conversationId: cid, repoDir: "/r", existing: [] }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ConversationStore, {
              list: () => Effect.fail(new Error("store down")),
            } as never),
            emptyTree,
            minerDies,
            verifierDies,
            fsDies,
          ),
        ),
      ),
    )
    expect(out).toEqual([])
  })
})
