import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { followUpTarget } from "./followUp.js"

describe("followUpTarget", () => {
  test("the LAST conversation ref wins; non-conversation refs and Nones are skipped", () => {
    expect(
      Option.getOrThrow(
        followUpTarget([
          Option.some("conversation:aaa"),
          Option.none(),
          Option.some("worktree:zzz"),
          Option.some("conversation:bbb"),
        ]),
      ),
    ).toBe("bbb")
    expect(Option.isNone(followUpTarget([]))).toBe(true)
    expect(Option.isNone(followUpTarget([Option.none(), Option.some("x:y")]))).toBe(true)
  })
})
