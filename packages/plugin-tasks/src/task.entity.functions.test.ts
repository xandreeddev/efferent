import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { ConversationId } from "@xandreed/core"
import type { JsonObject, SessionLogEvent } from "@xandreed/core"
import { deliveredOf } from "./task.entity.functions.js"

const session = ConversationId.make("00000000-0000-4000-8000-00000000b4b4")
const event = (seq: number, kind: string, data: JsonObject): SessionLogEvent => ({ session, seq, turn: Option.none(), kind, at: 0, data })

test("the inbox ids delivered are the inbox.queued records' ids; one that does not decode fails with session.decode", async () => {
  const delivered = await Effect.runPromise(deliveredOf([
    event(1, "inbox.queued", { id: "task:a", source: { kind: "task" }, content: "done" }),
    event(2, "task.started", { taskId: "b" }),
    event(3, "inbox.queued", { id: "task:c", source: {}, content: "" }),
  ]))
  expect([...delivered]).toEqual(["task:a", "task:c"])
  const broken = await Effect.runPromise(Effect.flip(deliveredOf([event(1, "inbox.queued", { id: 5, source: {}, content: "done" })])))
  expect([broken._tag, broken.code]).toEqual(["SessionLogError", "session.decode"])
})
