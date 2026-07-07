import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { makeScriptedImplementor, withTempWorkspace, writeWorkspaceFile } from "@xandreed/foundry"
import { LocalFileSystemLive } from "@xandreed/sdk-adapters"
import { SMITH_LIMIT_DEFAULTS } from "../domain/SmithConfig.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { runForgeSessionWith } from "./session.js"

const FAILING_TEST = `import { expect, test } from "bun:test"
test("sum", () => {
  expect(1 + 1).toBe(3)
})
`

const PASSING_TEST = `import { expect, test } from "bun:test"
test("sum", () => {
  expect(1 + 1).toBe(2)
})
`

const runFor = (cwd: string): SmithRunConfig => ({
  task: "make the sum test pass",
  cwd,
  acceptance: ["bun test exits 0"],
  maxAttempts: SMITH_LIMIT_DEFAULTS.maxAttempts,
  budgetMillis: SMITH_LIMIT_DEFAULTS.budgetMillis,
  models: { general: Option.none(), code: Option.none(), fast: Option.none() },
  allowBash: false,
  headless: true,
  testCommand: Option.none(),
  noTest: false,
  configPath: Option.none(),
})

describe("runForgeSessionWith — scripted E2E (no keys, no LLM)", () => {
  test("fail → feedback → fix → accepted, with the full event sequence", async () => {
    const events: SmithEvent[] = []
    const publish = (event: SmithEvent) =>
      Effect.sync(() => {
        events.push(event)
      })

    const { artifactExisted, result } = await Effect.runPromise(
      withTempWorkspace(tmpdir(), (dir) =>
        Effect.gen(function* () {
          yield* writeWorkspaceFile(dir, "package.json", `{ "name": "toy" }`)
          const implementor = makeScriptedImplementor([
            [{ path: "sum.test.ts", content: FAILING_TEST }],
            [{ path: "sum.test.ts", content: PASSING_TEST }],
          ])
          const result = yield* runForgeSessionWith(runFor(dir), publish, implementor).pipe(
            Effect.provide(LocalFileSystemLive),
          )
          // Checked INSIDE the scope — the temp workspace is removed on release.
          return { result, artifactExisted: existsSync(result.artifact) }
        }),
      ),
    )

    // The loop: rejected attempt 1 (failing test), accepted attempt 2.
    expect(result.run.outcome._tag).toBe("accepted")
    expect(Number(result.run.outcome._tag === "accepted" ? result.run.outcome.attempt : -1)).toBe(2)
    expect(result.run.attempts.length).toBe(2)
    expect(result.run.attempts[0]!.report.ok).toBe(false)
    // Attempt 1's feedback (fed to attempt 2) names the failed gate rule.
    expect(Option.getOrThrow(result.run.attempts[0]!.feedback)).toContain("test/bun-test")
    // The artifact was persisted inside the workspace.
    expect(artifactExisted).toBe(true)

    // The full event fan-in, in loop order.
    expect(events.map((event) => event.type)).toEqual([
      "forge_start",
      "attempt_start",
      "implement_end",
      "gate_start",
      "gate_report",
      "attempt_start",
      "implement_end",
      "gate_start",
      "gate_report",
      "forge_end",
    ])
  })
})
