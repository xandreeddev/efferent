import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import {
  Finding,
  GateName,
  makeScriptedImplementor,
  RuleId,
  withTempWorkspace,
  writeWorkspaceFile,
} from "@xandreed/foundry"
import type { Gate, TsProject } from "@xandreed/foundry"
import { SpecDoc } from "@xandreed/engine"
import { LocalFileSystemLive } from "@xandreed/providers"
import { SMITH_LIMIT_DEFAULTS } from "../domain/SmithConfig.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { loadWorkspaceRules, runForgeSessionWith } from "./session.js"

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
  headless: true,
  testCommand: Option.none(),
  noTest: false,
  configPath: Option.none(),
  ship: false,
  sandbox: false,
})

describe("loadWorkspaceRules — the AGENTS.md convention", () => {
  test("first existing file wins (AGENTS.md > CLAUDE.md); absent/empty read as None", async () => {
    const { both, claudeOnly, empty, none } = await Effect.runPromise(
      withTempWorkspace(tmpdir(), (dir) =>
        Effect.gen(function* () {
          const none = yield* loadWorkspaceRules(dir)
          yield* writeWorkspaceFile(dir, "CLAUDE.md", "claude rules here")
          const claudeOnly = yield* loadWorkspaceRules(dir)
          yield* writeWorkspaceFile(dir, "AGENTS.md", "agents rules WIN")
          const both = yield* loadWorkspaceRules(dir)
          yield* writeWorkspaceFile(dir, "AGENTS.md", "   \n  ")
          const empty = yield* loadWorkspaceRules(dir)
          return { none, claudeOnly, both, empty }
        }),
      ).pipe(Effect.provide(LocalFileSystemLive)),
    )
    expect(Option.isNone(none)).toBe(true)
    expect(Option.getOrThrow(claudeOnly)).toContain("claude rules here")
    expect(Option.getOrThrow(claudeOnly)).toContain("CLAUDE.md")
    expect(Option.getOrThrow(both)).toContain("agents rules WIN")
    expect(Option.getOrThrow(both)).toContain("Workspace rules (AGENTS.md")
    // An empty AGENTS.md falls through to the next candidate, not to None.
    expect(Option.getOrThrow(empty)).toContain("claude rules here")
  })

  test("an oversized rules file is clipped with a visible marker", async () => {
    const rules = await Effect.runPromise(
      withTempWorkspace(tmpdir(), (dir) =>
        writeWorkspaceFile(dir, "AGENTS.md", "x".repeat(20_000)).pipe(
          Effect.flatMap(() => loadWorkspaceRules(dir)),
        ),
      ).pipe(Effect.provide(LocalFileSystemLive)),
    )
    const text = Option.getOrThrow(rules)
    expect(text).toContain("[…rules clipped…]")
    expect(text.length).toBeLessThan(9_000)
  })
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
      "profile_status",
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
    // The check was RED on the untouched workspace — no vacuous warning.
    expect(events.some((event) => event.type === "vacuous_checks")).toBe(false)
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

  test("an extra JUDGE gate runs LAST; its rejection briefs the next attempt", async () => {
    const events: SmithEvent[] = []
    const publish = (event: SmithEvent) =>
      Effect.sync(() => {
        events.push(event)
      })
    const state = { judged: 0 }
    const scriptedJudge: Gate<TsProject> = {
      name: GateName.make("judge"),
      kind: "judge",
      deterministic: false,
      run: () =>
        Effect.sync(() => {
          state.judged += 1
          return state.judged === 1
            ? [
                new Finding({
                  rule: RuleId.make("judge/needs-work"),
                  severity: "error",
                  message: "out.txt reads as a stub",
                  location: Option.none(),
                  fixHint: Option.none(),
                }),
              ]
            : []
        }),
    }

    const doc = Effect.runSync(
      Schema.decodeUnknown(SpecDoc)({
        slug: "judge-loop",
        status: "locked",
        created: "2026-07-09T10:00:00Z",
        locked: "2026-07-09T10:05:00Z",
        goal: "Create out.txt in the workspace.",
        acceptance: ["out.txt exists"],
        constraints: [],
        nonGoals: [],
        checks: [{ name: "out-exists", command: "test -f out.txt" }],
        limits: { maxAttempts: 3, budgetMinutes: 5 },
        gates: { noTest: true },
      }),
    )

    const result = await Effect.runPromise(
      withTempWorkspace(tmpdir(), (dir) =>
        Effect.gen(function* () {
          yield* writeWorkspaceFile(dir, "package.json", `{ "name": "toy" }`)
          const implementor = makeScriptedImplementor([
            [{ path: "out.txt", content: "stub\n" }],
            [{ path: "out.txt", content: "real content\n" }],
          ])
          return yield* runForgeSessionWith(
            { ...runFor(dir), task: doc.goal },
            publish,
            implementor,
            Option.some(doc),
            () => [scriptedJudge],
          ).pipe(Effect.provide(LocalFileSystemLive))
        }),
      ),
    )

    // Deterministic gates were green; only the JUDGE rejected attempt 1.
    expect(result.run.outcome._tag).toBe("accepted")
    expect(result.run.attempts.length).toBe(2)
    expect(Option.getOrThrow(result.run.attempts[0]!.feedback)).toContain("judge/needs-work")
    expect(Option.getOrThrow(result.run.attempts[0]!.feedback)).toContain("stub")
    // Rank order: the accept gate STARTS before the judge in every attempt.
    const starts = events.filter((e) => e.type === "gate_start").map((e) =>
      e.type === "gate_start" ? e.gate : "",
    )
    expect(starts.indexOf("accept-out-exists")).toBeLessThan(starts.indexOf("judge"))
  })

  test("RED-FIRST: a check that already passes on the untouched workspace is flagged vacuous", async () => {
    const events: SmithEvent[] = []
    const publish = (event: SmithEvent) =>
      Effect.sync(() => {
        events.push(event)
      })

    const doc = Effect.runSync(
      Schema.decodeUnknown(SpecDoc)({
        slug: "make-out-file-vacuous",
        status: "locked",
        created: "2026-07-09T10:00:00Z",
        locked: "2026-07-09T10:05:00Z",
        goal: "Create out.txt in the workspace.",
        acceptance: ["out.txt exists", "package.json exists"],
        constraints: [],
        nonGoals: [],
        checks: [
          // Vacuous: package.json is seeded below — green before any work.
          { name: "pkg-exists", command: "test -f package.json" },
          // Real: red until the implementor writes it.
          { name: "out-exists", command: "test -f out.txt" },
        ],
        limits: { maxAttempts: 3, budgetMinutes: 5 },
        gates: { noTest: true },
      }),
    )

    const result = await Effect.runPromise(
      withTempWorkspace(tmpdir(), (dir) =>
        Effect.gen(function* () {
          yield* writeWorkspaceFile(dir, "package.json", `{ "name": "toy" }`)
          const implementor = makeScriptedImplementor([
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

    // The warning fired BEFORE attempt 1, naming only the vacuous check.
    const vacuousAt = events.findIndex((event) => event.type === "vacuous_checks")
    const attemptAt = events.findIndex((event) => event.type === "attempt_start")
    expect(vacuousAt).toBeGreaterThan(-1)
    expect(vacuousAt).toBeLessThan(attemptAt)
    const vacuous = events[vacuousAt]
    expect(vacuous?.type === "vacuous_checks" ? vacuous.names : []).toEqual([
      "accept-pkg-exists",
    ])
    // A warning, never a stop: the run proceeded and was accepted.
    expect(result.run.outcome._tag).toBe("accepted")
  })
})
