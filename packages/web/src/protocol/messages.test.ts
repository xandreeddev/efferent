import { describe, expect, test } from "bun:test"
import { formatUiActionMessage, parseActionPayload, parseClientMessage } from "./messages.js"

describe("parseClientMessage", () => {
  test("unwraps the htmx ws-send envelope (form fields + HEADERS)", () => {
    const envelope = JSON.stringify({ prompt: "hello", HEADERS: { "HX-Request": "true" } })
    expect(parseClientMessage(envelope)).toEqual({ type: "chat", prompt: "hello" })
  })

  test("accepts explicit typed messages", () => {
    expect(parseClientMessage(`{"type":"resync","HEADERS":{}}`)).toEqual({ type: "resync" })
    expect(parseClientMessage(`{"type":"ping"}`)).toEqual({ type: "ping" })
    expect(parseClientMessage(`{"type":"chat","prompt":" hi "}`)).toEqual({ type: "chat", prompt: "hi" })
  })

  test("drops garbage silently", () => {
    expect(parseClientMessage("not json")).toBeUndefined()
    expect(parseClientMessage(`"a string"`)).toBeUndefined()
    expect(parseClientMessage(`{"prompt":"   "}`)).toBeUndefined()
    expect(parseClientMessage(`{"type":"chat"}`)).toBeUndefined()
    expect(parseClientMessage(`[1,2]`)).toBeUndefined()
  })
})

describe("parseActionPayload / formatUiActionMessage", () => {
  test("extracts the reserved ui-id field and keeps the rest", () => {
    const p = parseActionPayload(new URLSearchParams("ui-id=ex-1&answer=3%2F4&HEADERS=x"))
    expect(p.id).toBe("ex-1")
    expect(p.fields["answer"]).toBe("3/4")
    expect(p.fields["HEADERS"]).toBeUndefined()
    expect(formatUiActionMessage(p)).toBe(`[ui:ex-1] answer="3/4"`)
  })

  test("works without a ui-id and from a plain record", () => {
    const p = parseActionPayload({ a: "1", b: "two" })
    expect(p.id).toBeUndefined()
    expect(formatUiActionMessage(p)).toBe(`[ui] a="1" b="two"`)
  })
})
