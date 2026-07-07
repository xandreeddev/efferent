import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { makeScriptedImplementor, withTempWorkspace, writeWorkspaceFile } from "@xandreed/foundry"
import { SpecDoc } from "@xandreed/sdk-core"
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

  test("a locked SpecDoc drives the run: its checks become accept gates", async () => {
    const events: SmithEvent[] = []
    const publish = (event: SmithEvent) =>
      Effect.sync(() => {
        events.push(event)
      })

    const doc = Effect.runSync(
      Schema.decodeUnknown(SpecDoc)({
        slug: "make-out-file",
        status: "locked",
        created: "2026-07-07T10:00:00Z",
        locked: "2026-07-07T10:05:00Z",
        goal: "Create out.txt in the workspace.",
        acceptance: ["out.txt exists"],
        constraints: ["touch nothing else"],
        nonGoals: [],
        checks: [{ name: "out-exists", command: "test -f out.txt" }],
        limits: { maxAttempts: 3, budgetMinutes: 5 },
        // The spec suppresses the auto bun-test gate — its own check is the bar.
        gates: { noTest: true },
      }),
    )

    const result = await Effect.runPromise(
      withTempWorkspace(tmpdir(), (dir) =>
        Effect.gen(function* () {
          yield* writeWorkspaceFile(dir, "package.json", `{ "name": "toy" }`)
          const implementor = makeScriptedImplementor([
            [], // attempt 1 writes nothing — the accept gate fails
            [{ path: "out.txt", content: "done\n" }],
          ])
          return yield* runForgeSessionWith(
            { ...runFor(dir), task: doc.goal },
            publish,
            implementor,
            Option.some(doc),
          ).pipe(Effect.provide(LocalFileSystemLive))
        }),
      ),
    )

    // The spec's machine check ran as the ONLY gate (noTest suppressed bun-test)…
    const start = events.find((event) => event.type === "forge_start")
    expect(start?.type === "forge_start" ? start.gateNames : []).toEqual(["accept-out-exists"])
    // …rejected attempt 1 with the check's rule id in the feedback…
    expect(result.run.attempts.length).toBe(2)
    expect(Option.getOrThrow(result.run.attempts[0]!.feedback)).toContain(
      "test/accept-out-exists",
    )
    // …and the artifact's Spec came from the doc.
    expect(result.run.outcome._tag).toBe("accepted")
    expect(result.run.spec.goal).toBe(doc.goal)
    expect(result.run.spec.acceptance).toEqual(doc.acceptance)
  })
})
