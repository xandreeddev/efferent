import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { LoopEvent } from "@xandreed/engine"
import { WorkspacePath } from "@xandreed/foundry"
import { capturePath } from "./filesTouched.js"

type ToolEnd = LoopEvent & { readonly type: "tool_end" }

const event = (over: Partial<Omit<ToolEnd, "type">>): ToolEnd => ({
  type: "tool_end",
  turnIndex: 0,
  toolCallId: "t1",
  toolName: "edit_file",
  args: { path: "src/foo.ts" },
  ok: true,
  result: {},
  ...over,
})

describe("capturePath", () => {
  test("successful edit_file / write_file yield the relative path", () => {
    expect(Option.getOrNull(capturePath(event({}), "/ws"))).toBe(WorkspacePath.make("src/foo.ts"))
    expect(
      Option.getOrNull(capturePath(event({ toolName: "write_file" }), "/ws")),
    ).toBe(WorkspacePath.make("src/foo.ts"))
  })

  test("absolute paths inside the workspace become workspace-relative", () => {
    expect(
      Option.getOrNull(capturePath(event({ args: { path: "/ws/src/deep/a.ts" } }), "/ws")),
    ).toBe(WorkspacePath.make("src/deep/a.ts"))
  })

  test("reads, failures, Bash, bad args, and escapes are None", () => {
    expect(Option.isNone(capturePath(event({ toolName: "read_file" }), "/ws"))).toBe(true)
    expect(Option.isNone(capturePath(event({ ok: false }), "/ws"))).toBe(true)
    expect(Option.isNone(capturePath(event({ toolName: "Bash", args: { command: "x" } }), "/ws"))).toBe(true)
    expect(Option.isNone(capturePath(event({ args: {} }), "/ws"))).toBe(true)
    expect(Option.isNone(capturePath(event({ args: { path: "" } }), "/ws"))).toBe(true)
    expect(
      Option.isNone(capturePath(event({ args: { path: "/elsewhere/b.ts" } }), "/ws")),
    ).toBe(true)
    expect(
      Option.isNone(capturePath(event({ args: { path: "../outside.ts" } }), "/ws")),
    ).toBe(true)
  })
})
