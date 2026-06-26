import { test, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { resolveTarget } from "./target.js"

test("release:<ver> resolves to a container target with the pinned spec + expected version", async () => {
  const t = await Effect.runPromise(resolveTarget("release:0.2.0"))
  expect(t.kind).toBe("container")
  if (t.kind === "container") {
    expect(t.spec).toBe("efferent@0.2.0")
    expect(t.expectVersion).toBe("0.2.0")
  }
})

test("npm:<tag> resolves to a container target; a non-version ref has no expected version", async () => {
  const t = await Effect.runPromise(resolveTarget("npm:latest"))
  expect(t.kind).toBe("container")
  if (t.kind === "container") {
    expect(t.spec).toBe("efferent@latest")
    expect(t.expectVersion).toBeUndefined()
  }
})

test("an unknown target dies with a helpful message", async () => {
  const exit = await Effect.runPromiseExit(resolveTarget("garbage"))
  expect(Exit.isFailure(exit)).toBe(true)
})

test("source resolves to a native target over the working tree (and cleans up)", async () => {
  const t = await Effect.runPromise(resolveTarget("source"))
  expect(t.kind).toBe("native")
  if (t.kind === "native") {
    expect(t.repoRoot).toBeDefined() // run from a source checkout
    expect(t.runner.supportsInProcess).toBe(true)
    await Effect.runPromise(t.runner.cleanup)
  }
})
