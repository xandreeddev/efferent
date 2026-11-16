// The row of chats (lesson 15): which headers are the learner's own, how each
// is labelled, and what the page says when `resume` did not show the chat
// asked for.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { JOURNAL_FORMAT, Owner, Seq, SessionId } from "@xandreed/core/kernel"
import type { SessionHeader } from "@xandreed/core/kernel"
import { chatsOf, ignoredLine } from "./chats.ts"

const id = (name: string) => SessionId.make(name)
const header = (name: string, more: Partial<SessionHeader> = {}): SessionHeader => ({ id: id(name), owner: Owner.make("learner"), createdAt: 0, format: JOURNAL_FORMAT, ...more })
const branchOf = (of: string, through: number): Partial<SessionHeader> => ({ branch: { of: id(of), through: Seq.make(through) } })

describe("the row of chats", () => {
  test("chats are numbered, a branch is named for its chat and turn, a branch of a branch for both, and a turn not read is left out", () => {
    const headers = [
      header("a"), header("b", branchOf("a", 4)), header("c", branchOf("b", 8)), header("d", branchOf("a", 4)),
      header("e"), header("f", branchOf("e", 4)), header("g", branchOf("gone", 4)),
    ]
    const turns = new Map([["b", 1], ["c", 2], ["d", 1], ["g", 1]])
    expect(chatsOf(headers, turns).map((chat) => chat.label)).toEqual([
      "Chat 1", "Chat 1, branch after turn 1", "Chat 1, branch after turn 1, branch after turn 2", "Chat 1, branch after turn 1 (2)",
      "Chat 2", "Chat 2, a branch", "Another chat, branch after turn 1",
    ])
  })

  test("a helper, a session of another owner and one of another format are not listed", () => {
    const headers = [header("a"), header("helper", { parent: id("a") }), header("other", { owner: Owner.make("someone") }), header("later", { format: 99 })]
    expect(chatsOf(headers, new Map()).map((chat) => chat.id)).toEqual([id("a")])
  })

  test("the page's word when resume showed another chat than the one asked for; none when it did, or when the chat asked for is not listed", () => {
    const chats = chatsOf([header("a"), header("b", branchOf("a", 4))], new Map([["b", 1]]))
    expect(ignoredLine(Option.some(id("a")), "b", chats)).toEqual(Option.some("The page asked for Chat 1, and the resume in chat.ts showed Chat 1, branch after turn 1: it decides which chat is shown, and it did not take the one asked for."))
    expect(ignoredLine(Option.some(id("a")), "a", chats)).toEqual(Option.none())
    expect(ignoredLine(Option.some(id("gone")), "a", chats)).toEqual(Option.none())
    expect(ignoredLine(Option.none(), "a", chats)).toEqual(Option.none())
  })
})
