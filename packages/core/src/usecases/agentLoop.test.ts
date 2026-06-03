import { describe, expect, it } from "bun:test"
import { Effect, Exit } from "effect"
import type { Toolkit } from "@effect/ai"
import { recoverMalformedToolCalls } from "./agentLoop.js"

/**
 * Build a fake resolved toolkit whose `handle` yields whatever Effect we pass.
 * Only the `handle` channel matters for `recoverMalformedToolCalls`.
 */
const fakeToolkit = (
  handle: (name: unknown, params: unknown) => Effect.Effect<unknown, unknown, never>,
): Toolkit.WithHandler<Record<string, never>> =>
  ({ tools: {}, handle }) as unknown as Toolkit.WithHandler<Record<string, never>>

const callHandle = (tk: Toolkit.WithHandler<Record<string, never>>) =>
  (tk.handle as unknown as (n: unknown, p: unknown) => Effect.Effect<unknown, unknown, never>)(
    "edit_file",
    {},
  )

describe("recoverMalformedToolCalls", () => {
  it("turns a MalformedOutput decode failure into a returned tool failure", () => {
    const base = fakeToolkit(() =>
      Effect.fail({
        _tag: "MalformedOutput",
        description: "Failed to decode tool call parameters for tool 'edit_file'",
      }),
    )
    const out = Effect.runSync(callHandle(recoverMalformedToolCalls(base))) as {
      isFailure: boolean
      result: { error: string; message: string }
      encodedResult: unknown
    }
    expect(out.isFailure).toBe(true)
    expect(out.result.error).toBe("InvalidToolCall")
    expect(out.result.message).toContain("edit_file")
    // The model-facing result and the wire-encoded result are the same object.
    expect(out.encodedResult).toEqual(out.result)
  })

  it("lets MalformedInput (a result encode/validate bug) propagate", () => {
    const base = fakeToolkit(() =>
      Effect.fail({ _tag: "MalformedInput", description: "Failed to validate tool call result" }),
    )
    const exit = Effect.runSyncExit(callHandle(recoverMalformedToolCalls(base)))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("passes a successful handler result through unchanged", () => {
    const ok = { isFailure: false, result: { path: "a.ts" }, encodedResult: { path: "a.ts" } }
    const base = fakeToolkit(() => Effect.succeed(ok))
    const out = Effect.runSync(callHandle(recoverMalformedToolCalls(base)))
    expect(out).toBe(ok)
  })
})
