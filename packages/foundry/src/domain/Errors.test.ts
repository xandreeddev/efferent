import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { AttemptNumber } from "./Brands.js"
import { ConfigError, ImplementorError, WorkspaceError, describeError } from "./Errors.js"

describe("errors keep the failure they wrap", () => {
  test("the cause stays a value: its class and a Node error's code survive", () => {
    const inner = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
    const error = new WorkspaceError({ message: "artifact write failed", cause: inner })
    expect(error.message).toBe("artifact write failed")
    expect(error.cause).toBe(inner)
    expect(error.cause).toHaveProperty("code", "ENOENT")
  })

  test("on the wire a cause is its name and message, never its stack", async () => {
    const inner = new RangeError("out of range")
    const encoded = await Effect.runPromise(
      Schema.encodeUnknownEffect(ImplementorError)(
        new ImplementorError({ attempt: AttemptNumber.make(2), message: "claude spawn failed", cause: inner }),
      ),
    )
    expect(encoded).toEqual({
      _tag: "ImplementorError",
      attempt: 2,
      message: "claude spawn failed",
      cause: { name: "RangeError", message: "out of range" },
    })
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(ImplementorError)(encoded))
    expect(describeError(decoded)).toBe("claude spawn failed: out of range")
  })

  test("an error without a cause encodes as it always did", async () => {
    const encoded = await Effect.runPromise(
      Schema.encodeUnknownEffect(ConfigError)(new ConfigError({ path: "foundry.config.ts", message: "unreadable" })),
    )
    expect(encoded).toEqual({ _tag: "ConfigError", path: "foundry.config.ts", message: "unreadable" })
  })
})

describe("describeError — the line a person reads", () => {
  test("the message alone when nothing is wrapped", () => {
    expect(describeError(new WorkspaceError({ message: "disk full" }))).toBe("disk full")
  })

  test("the message, then the wrapped failure's message, without a stack", () => {
    const line = describeError(new WorkspaceError({ message: "write of src/a.ts failed", cause: new Error("EACCES: permission denied") }))
    expect(line).toBe("write of src/a.ts failed: EACCES: permission denied")
    expect(line).not.toContain("\n")
  })

  test("a thrown string is its own message; a value with no message adds nothing", () => {
    expect(describeError(new WorkspaceError({ message: "spawn failed", cause: "no such binary" }))).toBe("spawn failed: no such binary")
    expect(describeError(new WorkspaceError({ message: "spawn failed", cause: 42 }))).toBe("spawn failed")
  })
})
