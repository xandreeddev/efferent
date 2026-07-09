import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { capabilitiesPhrase, renderEventLines } from "./eventLines.js"

describe("capabilitiesPhrase", () => {
  test("pluralizes each side and joins with a middot", () => {
    expect(capabilitiesPhrase({ skills: 2, mcpServers: 1, mcpTools: 5 })).toBe(
      "2 skills · 1 MCP server (5 tools)",
    )
    expect(capabilitiesPhrase({ skills: 1, mcpServers: 2, mcpTools: 3 })).toBe(
      "1 skill · 2 MCP servers (3 tools)",
    )
  })

  test("omits a zero side entirely", () => {
    expect(capabilitiesPhrase({ skills: 3, mcpServers: 0, mcpTools: 0 })).toBe("3 skills")
    expect(capabilitiesPhrase({ skills: 0, mcpServers: 1, mcpTools: 4 })).toBe(
      "1 MCP server (4 tools)",
    )
  })
})

describe("renderEventLines — capabilities", () => {
  test("a capabilities event prints one harness line", () => {
    const event: SmithEvent = { type: "capabilities", skills: 2, mcpServers: 1, mcpTools: 5 }
    expect(Option.getOrThrow(renderEventLines(event))).toBe(
      "  ⚙ harness: 2 skills · 1 MCP server (5 tools)",
    )
  })
})
