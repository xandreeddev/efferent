import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { AgentEvent } from "@xandreed/sdk-core"
import { makeAgentBus } from "../usecases/agentBus.js"
import { FAKE_ROOT_CID, fakeServerLive } from "./fakeAppEnv.js"
import { makeHttpTransport } from "../transport/http/client.js"

// "Messages flying": every inter-agent message (blackboard post, inbox message,
// completion note) is emitted as a board_note AgentEvent onto the daemon's
// ledger — so the dashboard's message stream is just the SSE stream.

describe("agent bus → board_note emit sink", () => {
  test("boardPost, inbox post, and completion all emit board_note events", async () => {
    const events: AgentEvent[] = []
    const bus = makeAgentBus((e) => Effect.sync(() => void events.push(e)))
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* bus.markRunning("root", "you")
        yield* bus.markRunning("n1", "agent one", { parentKey: "root" })
        yield* bus.boardPost({ from: "n1", note: "found the bug", at: 1 })
        yield* bus.post("root", { from: "n1", content: "ping the lead", at: 2 })
        yield* bus.complete("n1", { status: "ok", summary: "fixed it", filesChanged: [] })
      }),
    )
    const notes = events.filter((e) => e.type === "board_note")
    // boardPost + inbox post + completion = 3 distinct messages on the firehose.
    expect(notes.length).toBeGreaterThanOrEqual(3)
    expect(
      notes.some((n) => n.type === "board_note" && n.note === "found the bug" && n.from === "n1"),
    ).toBe(true)
    expect(notes.some((n) => n.type === "board_note" && n.note === "ping the lead")).toBe(true)
    expect(notes.some((n) => n.type === "board_note" && n.note.includes("fixed it"))).toBe(true)
  })

  test("a bus with no sink still works (emit is a no-op)", async () => {
    const bus = makeAgentBus()
    const board = await Effect.runPromise(
      Effect.gen(function* () {
        yield* bus.boardPost({ from: "x", note: "hi", at: 1 })
        return yield* bus.boardRead()
      }),
    )
    expect(board.map((n) => n.note)).toEqual(["hi"])
  })
})

describe("GET /messages over the wire", () => {
  test("the messages endpoint decodes (empty tail on a fresh daemon)", async () => {
    const msgs = await Effect.runPromise(
      Effect.gen(function* () {
        const t = makeHttpTransport("")
        return yield* t.messages(50)
      }).pipe(Effect.scoped, Effect.provide(fakeServerLive(FAKE_ROOT_CID))),
    )
    expect(Array.isArray(msgs)).toBe(true)
  })
})
