import { describe, expect, test } from "bun:test"
import { ConversationId } from "../domain/message.entity.js"
import { LeaseExpired, RevisionConflict, SessionLogError, SessionMissing } from "./session-log.entity.js"
import { isRevisionConflict, isStoreBusy } from "./session-log.entity.functions.js"

describe("isStoreBusy", () => {
  test("holds for a store that was too busy to answer, and for nothing else", () => {
    expect([
      new SessionLogError({ code: "store.busy", message: "the database is locked", cause: new Error("SQLITE_BUSY") }),
      new SessionLogError({ code: "store.io", message: "disk full" }),
    ].map(isStoreBusy)).toEqual([true, false])
  })
})

describe("isRevisionConflict", () => {
  test("holds for a conflict by its tag, from any copy of core, and for no other failure", () => {
    const session = ConversationId.make("7c1f3a52-9d4e-4b6a-8f21-3e5d6c7b8a90")
    expect([
      new RevisionConflict({ session, expected: 1, actual: 2 }),
      // Another copy of core's class: the same tag and fields.
      { _tag: "RevisionConflict", session, expected: 1, actual: 2 },
      new LeaseExpired({ session, notAfter: 1, now: 2 }),
      new SessionMissing({ session }),
      new SessionLogError({ code: "store.busy", message: "the database is locked" }),
      "RevisionConflict",
      undefined,
    ].map(isRevisionConflict)).toEqual([true, true, false, false, false, false, false])
  })
})
