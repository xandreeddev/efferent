import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { ConversationStore, UtilityCompletion, UtilityError, UtilityLlm } from "@xandreed/engine"
import type { AgentMessage } from "@xandreed/engine"
import { SqliteConversationStoreLive } from "@xandreed/providers"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { digestPrompt, foldConversation, profileDrift, renderTrailForDigest } from "./efferentImplementor.js"

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 }

const stubUtility = (text: string) =>
  Layer.succeed(UtilityLlm, {
    complete: () => Effect.succeed(new UtilityCompletion({ text, usage })),
  })

const failingUtility = Layer.succeed(UtilityLlm, {
  complete: () => Effect.fail(new UtilityError({ message: "fast tier down" })),
})

const trail: ReadonlyArray<AgentMessage> = [
  { role: "user", content: "Port the stats module. Acceptance: bun test green." },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "Two files map cleanly." },
      { type: "text", text: "Starting with the reader." },
      { type: "tool-call", toolCallId: "t1" as never, toolName: "write_file", input: { path: "src/stats.ts" } },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "t1" as never, toolName: "write_file", output: { written: true }, isError: false },
    ],
  },
]

describe("the armed-profile tripwire (#111)", () => {
  test("edit, deletion, and creation each count as drift; unchanged never does", () => {
    const paths = ["a/foundry.config.ts", "a/custom.ts"]
    const armed = [Option.some("typecheck: true"), Option.none<string>()]
    expect(profileDrift(paths, armed, [Option.some("typecheck: true"), Option.none()])).toEqual([])
    expect(profileDrift(paths, armed, [Option.some("typecheck: false"), Option.none()])).toEqual(["a/foundry.config.ts"])
    expect(profileDrift(paths, armed, [Option.none(), Option.none()])).toEqual(["a/foundry.config.ts"])
    expect(profileDrift(paths, armed, [Option.some("typecheck: true"), Option.some("new")])).toEqual(["a/custom.ts"])
  })
})

describe("attempt-boundary compaction", () => {
  test("renderTrailForDigest: one dense line per part; head + tail survive a clip", () => {
    const rendered = renderTrailForDigest(trail)
    expect(rendered).toContain("USER: Port the stats module.")
    expect(rendered).toContain("THOUGHT: Two files map cleanly.")
    expect(rendered).toContain("ASSISTANT: Starting with the reader.")
    expect(rendered).toContain('TOOL CALL: write_file({"path":"src/stats.ts"})')
    expect(rendered).toContain("TOOL RESULT write_file")

    // Each part clips to ~400 chars, so the TOTAL cap needs volume: 400
    // messages ≈ 160k rendered chars > the 120k transcript cap.
    const noisy: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(50_000) }],
    }
    const clipped = renderTrailForDigest([trail[0]!, ...Array.from({ length: 400 }, () => noisy)])
    // The brief (head) survives; the middle is dropped; the tail remains.
    expect(clipped.startsWith("USER: Port the stats module.")).toBe(true)
    expect(clipped).toContain("[…mid-transcript clipped…]")
    expect(clipped.length).toBeLessThan(130_000)
  })

  test("digestPrompt folds a prior handoff in when one exists", () => {
    expect(digestPrompt("T", Option.none())).not.toContain("EARLIER handoff")
    expect(digestPrompt("T", Option.some("old facts"))).toContain("old facts")
  })

  test("foldConversation: checkpoint written, window folded, event published", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smith-fold-"))
    const events: SmithEvent[] = []
    const publish = (event: SmithEvent) =>
      Effect.sync(() => {
        events.push(event)
      })

    const program = Effect.gen(function* () {
      const store = yield* ConversationStore
      const cid = yield* store.create("/tmp/ws")
      yield* Effect.forEach(trail, (message) => store.append(cid, message))
      yield* foldConversation({ conversationId: cid, attempt: 2, contextTokens: 90_000, publish })
      const checkpoint = yield* store.latestCheckpoint(cid)
      const active = yield* store.listActive(cid)
      const all = yield* store.list(cid)
      return { checkpoint, active, all }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteConversationStoreLive(join(dir, "smith.db")),
          stubUtility("HANDOFF: task is the stats port; src/stats.ts written."),
        ),
      ),
    )
    const { checkpoint, active, all } = await Effect.runPromise(program)

    // The fold: summary persisted, active window empty, full trail intact.
    expect(Option.isSome(checkpoint)).toBe(true)
    expect(Option.getOrThrow(checkpoint).summary).toContain("HANDOFF: task is the stats port")
    expect(active).toEqual([])
    expect(all.length).toBe(trail.length)
    // The pane learns why the next attempt opens from a summary.
    expect(events).toEqual([{ type: "context_folded", attempt: 2, tokens: 90_000 }])
  })

  test("a failed digest is BEST-EFFORT: no checkpoint, no event, no error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smith-fold-"))
    const events: SmithEvent[] = []
    const publish = (event: SmithEvent) =>
      Effect.sync(() => {
        events.push(event)
      })

    const program = Effect.gen(function* () {
      const store = yield* ConversationStore
      const cid = yield* store.create("/tmp/ws")
      yield* Effect.forEach(trail, (message) => store.append(cid, message))
      yield* foldConversation({ conversationId: cid, attempt: 2, contextTokens: 90_000, publish })
      return {
        checkpoint: yield* store.latestCheckpoint(cid),
        active: yield* store.listActive(cid),
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SqliteConversationStoreLive(join(dir, "smith.db")), failingUtility),
      ),
    )
    const { checkpoint, active } = await Effect.runPromise(program)

    // The trail stays unfolded — the attempt just runs on full context.
    expect(Option.isNone(checkpoint)).toBe(true)
    expect(active.length).toBe(trail.length)
    expect(events).toEqual([])
  })

  test("an EMPTY digest never checkpoints (a blank handoff would amnesia the coder)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smith-fold-"))
    const program = Effect.gen(function* () {
      const store = yield* ConversationStore
      const cid = yield* store.create("/tmp/ws")
      yield* Effect.forEach(trail, (message) => store.append(cid, message))
      yield* foldConversation({
        conversationId: cid,
        attempt: 2,
        contextTokens: 90_000,
        publish: () => Effect.void,
      })
      return yield* store.latestCheckpoint(cid)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SqliteConversationStoreLive(join(dir, "smith.db")), stubUtility("  \n ")),
      ),
    )
    expect(Option.isNone(await Effect.runPromise(program))).toBe(true)
  })
})
