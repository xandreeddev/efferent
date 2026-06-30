import { describe, expect, test } from "bun:test"
import { renderScopeSystemPrompt } from "./scopeAgent.js"
import { coordinationSection } from "./sections.js"

const COMMS_TOOLS = ["read_file", "grep", "ls", "send_message", "blackboard_post", "blackboard_read"]
const READONLY_TOOLS = ["read_file", "grep", "glob", "ls", "Bash"]

describe("coordinationSection — gated by the role's real capabilities", () => {
  test("a comms-capable role is told to read the blackboard first", () => {
    const s = coordinationSection({ canWait: false, hasComms: true })
    expect(s).toContain("Read the blackboard FIRST")
    expect(s).toContain("blackboard_read")
  })

  test("a role with neither comms nor wait gets NOTHING (no dead blackboard nudge)", () => {
    expect(coordinationSection({ canWait: false, hasComms: false })).toBe("")
  })

  test("the wait_for_agents loop appears only for a role that can wait", () => {
    expect(coordinationSection({ canWait: false, hasComms: true })).not.toContain("wait_for_agents")
    expect(coordinationSection({ canWait: true, hasComms: true })).toContain("wait_for_agents")
  })

  test("the nudge is injected into a comms-capable sub-agent's prompt — but NOT a read-only one", () => {
    const comms = renderScopeSystemPrompt({
      name: "worker",
      rootDir: "/tmp/ws/pkg",
      displayRoot: "/tmp/ws",
      body: "do the thing",
      now: new Date("2026-06-20T00:00:00Z"),
      toolNames: COMMS_TOOLS,
    })
    expect(comms).toContain("Read the blackboard FIRST")

    const readonly = renderScopeSystemPrompt({
      name: "architect",
      rootDir: "/tmp/ws/pkg",
      displayRoot: "/tmp/ws",
      body: "review it",
      now: new Date("2026-06-20T00:00:00Z"),
      toolNames: READONLY_TOOLS,
    })
    expect(readonly).not.toContain("Read the blackboard FIRST")
  })

  test("the coordination text is STATIC — no timestamp baked in (cache-safe prefix)", () => {
    const render = (now: Date) =>
      renderScopeSystemPrompt({
        name: "w",
        rootDir: "/tmp/ws/pkg",
        displayRoot: "/tmp/ws",
        body: "b",
        now,
        toolNames: COMMS_TOOLS,
      })
    const a = render(new Date("2026-06-20T00:00:00Z"))
    const b = render(new Date("2026-06-20T12:34:56Z"))
    const nudge = coordinationSection({ canWait: false, hasComms: true })
    expect(a.includes(nudge)).toBe(true)
    expect(b.includes(nudge)).toBe(true)
  })
})
