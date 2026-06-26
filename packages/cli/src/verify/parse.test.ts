import { test, expect } from "bun:test"
import {
  finalTextOf,
  parseJsonlEvents,
  parseRpcLines,
  rpcResultFor,
  toolCallsOf,
  usedToolOk,
} from "./parse.js"

test("parseJsonlEvents keeps JSON objects and drops noise", () => {
  const out = `not json
{"type":"turn_start","turnIndex":0}
[skip arrays]
{"type":"agent_end","finalText":"done"}
{ broken`
  const events = parseJsonlEvents(out)
  expect(events.length).toBe(2)
  expect(events[0]!["type"]).toBe("turn_start")
})

test("finalTextOf returns the last agent_end finalText", () => {
  const events = parseJsonlEvents(
    `{"type":"agent_end","finalText":"first"}\n{"type":"agent_end","finalText":"last"}`,
  )
  expect(finalTextOf(events)).toBe("last")
  expect(finalTextOf([])).toBeUndefined()
})

test("toolCallsOf + usedToolOk read tool_call_end results", () => {
  const events = parseJsonlEvents(
    `{"type":"tool_call_end","toolName":"write_file","ok":true}
{"type":"tool_call_end","toolName":"grep","ok":false}`,
  )
  expect(toolCallsOf(events)).toEqual([
    { name: "write_file", ok: true },
    { name: "grep", ok: false },
  ])
  expect(usedToolOk(events, ["write_file", "Bash"])).toBe(true)
  expect(usedToolOk(events, ["grep"])).toBe(false) // grep failed
  expect(usedToolOk(events, ["edit_file"])).toBe(false)
})

test("parseRpcLines splits responses (have id) from notifications (method only)", () => {
  const out = `{"jsonrpc":"2.0","method":"agent.event","params":{"event":{"type":"turn_start"}}}
{"jsonrpc":"2.0","id":1,"result":{"finalText":"hi","conversationId":"c1"}}`
  const parsed = parseRpcLines(out)
  expect(parsed.notifications.length).toBe(1)
  expect(parsed.responses.length).toBe(1)
  expect(rpcResultFor(parsed, 1)).toEqual({ finalText: "hi", conversationId: "c1" })
  expect(rpcResultFor(parsed, 2)).toBeUndefined()
})
