import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import {
  parseArgs,
  SELFTEST_TASK,
  toRunConfig,
  toSelftestRun,
} from "./main.js"

describe("the argv fold", () => {
  test("selftest is a reserved first token — no command, no task, flag set", () => {
    const state = parseArgs(["selftest"])
    expect(state.selftest).toBe(true)
    expect(Option.isNone(state.command)).toBe(true)
    expect(Option.isNone(state.task)).toBe(true)
    expect(state.errors).toEqual([])
  })

  test("selftest overrides fold onto the parsed run: canned task, headless, bounded attempts", () => {
    const base = toRunConfig(parseArgs(["selftest", "--max-attempts", "10"]), "")
    const run = toSelftestRun(base, "/tmp/x")
    expect(run.cwd).toBe("/tmp/x")
    expect(run.task).toBe(SELFTEST_TASK)
    expect(run.headless).toBe(true)
    expect(run.maxAttempts).toBe(3)
    expect(run.acceptance.length).toBeGreaterThan(0)
  })

  test("selftest after a task stays a positional (the reserved slot is first only)", () => {
    const state = parseArgs(["fix the tests", "selftest"])
    expect(state.selftest).toBe(false)
    expect(state.errors.length).toBeGreaterThan(0)
  })
})
