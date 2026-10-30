import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { InboxDroppedData, InboxQueuedData, TurnStartedData } from "../session/session-event.entity.js"
import { InboxItemId } from "../session/sessions.entity.js"
import { ModelRequestHeader } from "../turn/model-request.entity.js"
import { InvocationId, RunId } from "./run.entity.js"

describe("turn identities", () => {
  test("an id is minted, never a bare string, and one kind of id is not another", () => {
    const runId = RunId.make("run-1")
    // @ts-expect-error -- a bare string is not a run id: mint one with RunId.make.
    const bare: RunId = "run-1"
    // @ts-expect-error -- a run id is not an invocation id.
    const crossed: InvocationId = runId
    // @ts-expect-error -- nor an inbox item id.
    const inbox: InboxItemId = runId
    expect([bare, crossed, inbox].map(String)).toEqual(["run-1", "run-1", "run-1"])
  })

  test("a brand adds no check to a stored id: what was stored reads back, while a sender's inbox item id keeps its checks", () => {
    const decodes = <S extends Schema.Decoder<unknown>>(schema: S, data: unknown) => Option.isSome(Schema.decodeUnknownOption(schema)(data))
    expect([
      decodes(InboxQueuedData, { id: " padded ", source: {}, content: "x" }),
      decodes(InboxDroppedData, { id: "", reason: "attempts" }),
      decodes(TurnStartedData.mapFields((fields) => ({ runId: fields.runId })), { runId: "" }),
      decodes(ModelRequestHeader.mapFields((fields) => ({ runId: fields.runId })), { runId: " " }),
    ]).toEqual([true, true, true, true])
    expect([decodes(InboxItemId, " padded "), decodes(InboxItemId, ""), decodes(InboxItemId, "task:1")]).toEqual([false, false, true])
  })
})
