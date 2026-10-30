import { describe, expect, it } from "bun:test"
import { Option } from "effect"
import { bindingFor, droppedInBody, droppedInMessageStart, droppedReasonsOf, firstEventData, mergeBetas } from "./thinking-binding.entity.functions.js"

describe("mergeBetas", () => {
  it("adds each beta once after the ones the header holds, in order, and keeps the header's own", () => {
    expect(mergeBetas(Option.none(), ["b1"])).toBe("b1")
    expect(mergeBetas(Option.some("lib-1,lib-2"), ["oauth-1", "lib-2", "oauth-2"])).toBe("lib-1,lib-2,oauth-1,oauth-2")
    expect(mergeBetas(Option.some(" lib-1 , ,lib-1"), ["b1", "b1"])).toBe("lib-1,b1")
    expect(mergeBetas(Option.some(""), [])).toBe("")
  })
})

describe("bindingFor", () => {
  it("binds only a model that binds thinking, and only for a behaviour other than the provider's default", () => {
    expect([bindingFor(true, "drop_block"), bindingFor(true, "error"), bindingFor(true, "provider-default"), bindingFor(false, "drop_block")])
      .toEqual([Option.some("drop_block"), Option.some("error"), Option.none(), Option.none()])
  })
})

describe("what the provider dropped", () => {
  const changes = [
    { type: "thinking_dropped", reason: "prefix_binding_mismatch" },
    { type: "thinking_mismatch_allowed", reason: "prefix_binding_mismatch" },
    { type: "thinking_dropped" },
  ]

  it("counts the dropped blocks only, a missing reason as unknown", () => {
    expect(droppedReasonsOf(changes)).toEqual(["prefix_binding_mismatch", "unknown"])
  })

  it("reads a settled body's input_transformations, its other fields ignored; anything else reports nothing", () => {
    expect(droppedInBody(JSON.stringify({ id: "msg_1", content: [], input_transformations: changes }))).toEqual(["prefix_binding_mismatch", "unknown"])
    expect(droppedInBody(JSON.stringify({ id: "msg_1", content: [] }))).toEqual([])
    expect(droppedInBody("not json")).toEqual([])
    expect(droppedInBody(JSON.stringify({ input_transformations: "wrong" }))).toEqual([])
  })

  it("reads a stream's message_start, on its message or on the event; another event reports nothing", () => {
    expect(droppedInMessageStart(JSON.stringify({ type: "message_start", message: { id: "msg_1", input_transformations: changes } }))).toEqual(["prefix_binding_mismatch", "unknown"])
    expect(droppedInMessageStart(JSON.stringify({ type: "message_start", input_transformations: changes.slice(0, 1), message: { id: "msg_1" } }))).toEqual(["prefix_binding_mismatch"])
    expect(droppedInMessageStart(JSON.stringify({ type: "ping", input_transformations: changes }))).toEqual([])
  })
})

describe("firstEventData", () => {
  it("is the first event's data lines once its blank line came, whatever comes after; none before", () => {
    expect(firstEventData("event: message_start\ndata: {\"a\":1}")).toEqual(Option.none())
    expect(firstEventData("event: message_start\ndata: {\"a\":1}\n\nevent: ping\ndata: {}\n\n")).toEqual(Option.some("{\"a\":1}"))
    expect(firstEventData("event: message_start\r\ndata: one\r\ndata:two\r\n\r\n")).toEqual(Option.some("one\ntwo"))
  })
})
