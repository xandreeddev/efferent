import { expect, test } from "bun:test"
import { Schema } from "effect"
import { FeedPayload, FeedTransient, JournalRecord } from "./feed-frame.entity.js"

test.each(["update\nid: forged", "update\rdata: forged", "update\0forged"])("feed event names reject cursor injection: %j", (event) => {
  expect(Schema.decodeUnknownResult(FeedPayload)({ event, data: {} })._tag).toBe("Failure")
  expect(Schema.decodeUnknownResult(FeedTransient)({ _tag: "FeedTransient", event, data: {} })._tag).toBe("Failure")
  expect(Schema.decodeUnknownResult(JournalRecord)({ sequence: 1, kind: event, data: {} })._tag).toBe("Failure")
})
