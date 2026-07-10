import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { EngineSettings } from "@xandreed/engine"
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

describe("knob resolution — flags > config > defaults", () => {
  const config = new EngineSettings({
    maxAttempts: Option.some(7),
    budgetMillis: Option.some(600_000),
    sandbox: Option.some(false),
  })

  test("an unspecified flag falls to the config value", () => {
    const run = toRunConfig(parseArgs(["do it"]), "do it", config)
    expect(run.maxAttempts).toBe(7)
    expect(run.budgetMillis).toBe(600_000)
    expect(run.sandbox).toBe(false)
  })

  test("an explicit flag beats the config", () => {
    const run = toRunConfig(
      parseArgs(["do it", "--max-attempts", "2", "--budget", "5"]),
      "do it",
      config,
    )
    expect(run.maxAttempts).toBe(2)
    expect(run.budgetMillis).toBe(5 * 60_000)
    // --no-sandbox is the only sandbox flag; unspecified still reads config.
    expect(run.sandbox).toBe(false)
  })

  test("no flag, no config → the smith defaults (sandbox ON)", () => {
    const run = toRunConfig(parseArgs(["do it"]), "do it")
    expect(run.maxAttempts).toBe(3)
    expect(run.budgetMillis).toBe(15 * 60_000)
    expect(run.sandbox).toBe(true)
  })
})
