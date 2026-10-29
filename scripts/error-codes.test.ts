import { describe, expect, test } from "bun:test"
import { codeListProblems, raisedCodes } from "./error-codes.js"

const source = [
  `const closed = new HarnessError({ code: "turn.closed", message: "closed" })`,
  `const io = failure("store.io")`,
  `const model = harnessError("loop.model", "no LanguageModel")`,
  `const state = storage("session.state")`,
  `const duplicate = harness("tools.duplicate", "two tools")`,
  `const probe = new HarnessError({ code: "conformance.session", message: "probe" })`,
  `const event = Schema.TaggedStruct("turn.started", {})`,
  `const span = Effect.withSpan("agent.turn")`,
  `const node = { code: "ENOENT" }`,
].join("\n")

describe("raisedCodes", () => {
  test("reads a code field and the packages' error helpers, not an event's or a span's name", () => {
    expect([...raisedCodes(source)].toSorted()).toEqual(["conformance.session", "loop.model", "session.state", "store.io", "tools.duplicate", "turn.closed"])
  })
})

describe("codeListProblems", () => {
  const published = ["loop.model", "session.busy", "session.state", "store.io", "tools.duplicate", "turn.closed"]
  const agreeing = { published, entries: ["loop.model", "session.state", "store.io", "tools.duplicate", "turn.closed"], begin: ["session.busy"], raised: raisedCodes(source) }

  test("none when every raised code is published and every published code has its entry; the kits' own codes aside", () => {
    expect(codeListProblems(agreeing)).toEqual([])
  })

  test("a raised code outside the list is a problem in every namespace, a store's included", () => {
    expect(codeListProblems({ ...agreeing, raised: new Set([...agreeing.raised, "store.busy", "matcher.timeout"]) })).toEqual([
      "Error code matcher.timeout is raised in a package but not in HARNESS_CODES (packages/core/src/harness/harness-code.entity.ts)",
      "Error code store.busy is raised in a package but not in HARNESS_CODES (packages/core/src/harness/harness-code.entity.ts)",
    ])
  })

  test("a published code without an entry, an entry twice or for an unpublished code, an unpublished begin code are problems", () => {
    expect(codeListProblems({ ...agreeing, entries: ["loop.model", "loop.model", "session.state", "tools.duplicate", "turn.closed", "turn.close"], begin: ["session.busy", "session.idle"] })).toEqual([
      "Error code loop.model has two entries",
      "Error code turn.close has an entry but is not in HARNESS_CODES",
      "Begin code session.idle is not in HARNESS_CODES",
      "Published code store.io has no entry in ERROR_CODES or TASK_CODES",
    ])
  })
})
