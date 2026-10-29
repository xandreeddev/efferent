import { describe, expect, test } from "bun:test"
import { SessionLogError } from "./session-log.entity.js"
import { isStoreBusy } from "./session-log.entity.functions.js"

describe("isStoreBusy", () => {
  test("holds for a store that was too busy to answer, and for nothing else", () => {
    expect([
      new SessionLogError({ code: "store.busy", message: "the database is locked", cause: new Error("SQLITE_BUSY") }),
      new SessionLogError({ code: "store.io", message: "disk full" }),
    ].map(isStoreBusy)).toEqual([true, false])
  })
})
