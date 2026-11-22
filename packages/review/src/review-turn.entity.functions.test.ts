import { describe, expect, test } from "bun:test"
import type { Prompt, Response } from "effect/ai"
import { thoughtsOf, withThoughts } from "./review-turn.entity.functions.js"

const signed = { provider: { info: { type: "thinking", signature: "sig-1" } } }
const start = (id: string) => ({ type: "reasoning-start", id, metadata: {} }) as Response.AnyPart
const delta = (id: string, text: string, metadata: Response.ProviderMetadata = {}) => ({ type: "reasoning-delta", id, delta: text, metadata }) as Response.AnyPart

describe("thoughtsOf", () => {
  test("each thought's text and metadata folded in order; a thought with no metadata left out", () => {
    expect(thoughtsOf([
      start("0"), delta("0", "Weigh "), delta("0", "it."), delta("0", "", signed),
      start("1"), delta("1", "No signature."),
      start("2"), delta("2", "", { provider: { info: { type: "redacted", redactedData: "x" } } }),
    ])).toEqual([
      { id: "0", text: "Weigh it.", options: signed },
      { id: "2", text: "", options: { provider: { info: { type: "redacted", redactedData: "x" } } } },
    ])
  })

  test("no reasoning parts, no thoughts; a delta with no start is passed over", () => {
    expect([thoughtsOf([]), thoughtsOf([delta("9", "stray", signed)])]).toEqual([[], []])
  })
})

describe("withThoughts", () => {
  const call = (id: string): Prompt.ToolCallPartEncoded => ({ type: "tool-call", id, name: "readLines", params: { path: "a.ts" } })
  const context: ReadonlyArray<Prompt.MessageEncoded> = [
    { role: "user", content: "Review it." },
    { role: "assistant", content: [{ type: "text", text: "Reading." }, call("c1"), call("c2")] },
    { role: "tool", content: [{ type: "tool-result", id: "c1", name: "readLines", result: "1| x", isFailure: false }] },
    { role: "assistant", content: [call("c3")] },
    { role: "assistant", content: "Done." },
  ]

  test("an answer's thoughts go first in it, the answer known by its first call; the others are as they were", () => {
    const thoughts = new Map([["c1", [{ id: "0", text: "", options: signed }]]])
    const sent = withThoughts(context, thoughts)
    expect(sent[1]).toEqual({ role: "assistant", content: [{ type: "reasoning", text: "", options: signed }, { type: "text", text: "Reading." }, call("c1"), call("c2")] })
    expect([sent[0], sent[2], sent[3], sent[4]]).toEqual([context[0], context[2], context[3], context[4]])
  })

  test("no thoughts: the context itself; a thought kept under a later call's id finds no answer", () => {
    expect([withThoughts(context, new Map()) === context, withThoughts(context, new Map([["c2", [{ id: "0", text: "", options: signed }]]]))]).toEqual([true, context])
  })
})
