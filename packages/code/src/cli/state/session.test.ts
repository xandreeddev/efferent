import { describe, expect, test } from "bun:test"
import type { ConversationId } from "@xandreed/sdk-core"
import { createSessionSlice } from "./session.js"

const cid = "00000000-0000-0000-0000-000000000000" as unknown as ConversationId

const slice = () =>
  createSessionSlice({
    status: { modelId: "m", cwd: "/w", storage: "sqlite" },
    conversationId: cid,
    footer: "f",
  })

describe("the reactive queued-message mirror", () => {
  test("enqueue / dequeue / popQueued keep the `queued()` signal in lockstep", () => {
    const s = slice()
    expect(s.queued()).toEqual([])

    s.run.enqueue("first")
    s.run.enqueue("second")
    expect(s.queued()).toEqual(["first", "second"])

    // dequeue drains from the FRONT (turn order)…
    expect(s.run.dequeue()).toBe("first")
    expect(s.queued()).toEqual(["second"])

    // …popQueued pulls from the BACK (↑-to-edit the most recent).
    expect(s.run.popQueued()).toBe("second")
    expect(s.queued()).toEqual([])
    expect(s.run.popQueued()).toBeUndefined()
  })

  test("newConversation clears the queue (and the signal)", () => {
    const s = slice()
    s.run.enqueue("pending")
    expect(s.queued()).toEqual(["pending"])
    s.run.newConversation(cid)
    expect(s.queued()).toEqual([])
  })
})
