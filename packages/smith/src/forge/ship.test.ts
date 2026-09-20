import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { FactoryRun } from "@xandreed/foundry"
import { Shell, ShellError } from "@xandreed/core"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { HARNESS_STATE_PATHSPECS, renderShipPlan, runShip } from "./ship.js"

const run = Schema.decodeUnknownSync(FactoryRun)({
  id: "22222222-2222-4222-8222-222222222222",
  spec: {
    goal: "Port the stats module to TypeScript with tests.",
    acceptance: ["bun test exits 0"],
    limits: { maxAttempts: 3, budgetMillis: 1000 },
  },
  attempts: [
    {
      attempt: 1,
      report: {
        verdicts: [
          { _tag: "pass", gate: "typecheck", durationMs: 1, findings: [] },
          { _tag: "pass", gate: "bun-test", durationMs: 1, findings: [] },
        ],
      },
      filesTouched: [],
      durationMs: 5,
    },
  ],
  outcome: { _tag: "accepted", attempt: 1 },
  startedAt: 0,
  endedAt: 10,
})

const plan = renderShipPlan("/ws", Option.none(), run)

/** A scripted Shell: canned stdout per command prefix, every call recorded. */
const scriptedShell = (
  calls: string[],
  respond: (command: string) => { stdout: string; exitCode: number },
) =>
  Layer.succeed(Shell, {
    exec: (command: string) =>
      Effect.sync(() => {
        calls.push(command)
        const r = respond(command)
        return { stdout: r.stdout, stderr: r.exitCode === 0 ? "" : "boom", exitCode: r.exitCode }
      }),
  })

const collect = () => {
  const events: SmithEvent[] = []
  const publish = (event: SmithEvent) =>
    Effect.sync(() => {
      events.push(event)
    })
  return { events, publish }
}

describe("the ship step", () => {
  test("the plan derives branch/subject/gates from the run artifact", () => {
    expect(plan.branch).toBe("smith/run-22222222")
    expect(plan.subject).toBe("Port the stats module to TypeScript with tests.")
    expect(plan.commitBody).toContain("gates green: typecheck, bun-test")
    expect(plan.prBody).toContain("bun test exits 0")
    expect(plan.prBody).toContain(".foundry/runs/22222222")
  })

  test("on main: branch → stage → commit → push → PR, url returned, all steps ok", async () => {
    const calls: string[] = []
    const { events, publish } = collect()
    const url = await Effect.runPromise(
      runShip(plan, publish).pipe(
        Effect.provide(
          scriptedShell(calls, (command) =>
            command.startsWith("git rev-parse")
              ? { stdout: "main\n", exitCode: 0 }
              : command.startsWith("git diff --cached")
                ? { stdout: "", exitCode: 1 } // something is staged
                : command.startsWith("gh pr create")
                  ? { stdout: "https://github.com/x/y/pull/7\n", exitCode: 0 }
                  : { stdout: "", exitCode: 0 },
          ),
        ),
      ),
    )
    expect(Option.getOrThrow(url)).toBe("https://github.com/x/y/pull/7")
    // Steps AND the two silent probes (staged? · PR already open?), in order.
    expect(calls.map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual([
      "git rev-parse",
      "git checkout",
      "git add",
      "git diff",
      "git commit",
      "git push",
      "gh pr",
      "gh pr",
    ])
    expect(calls[1]).toContain("smith/run-22222222")
    // The probes are questions, not steps: exactly six steps reach the pane.
    expect(events.map((e) => (e.type === "ship_step" ? e.step : "?"))).toEqual([
      "branch",
      "checkout",
      "stage",
      "commit",
      "push",
      "pr",
    ])
    expect(events.every((e) => e.type === "ship_step" && e.ok)).toBe(true)
  })

  test("on a feature branch: no checkout, ship stays on the human's branch", async () => {
    const calls: string[] = []
    const { publish } = collect()
    await Effect.runPromise(
      runShip(plan, publish).pipe(
        Effect.provide(
          scriptedShell(calls, (command) =>
            command.startsWith("git rev-parse")
              ? { stdout: "feat/my-work\n", exitCode: 0 }
              : { stdout: "https://github.com/x/y/pull/8", exitCode: 0 },
          ),
        ),
      ),
    )
    expect(calls.some((c) => c.startsWith("git checkout"))).toBe(false)
    expect(calls.find((c) => c.startsWith("git push"))).toContain("feat/my-work")
  })

  test("a failed step STOPS the sequence — commit fails, nothing pushes", async () => {
    const calls: string[] = []
    const { events, publish } = collect()
    const url = await Effect.runPromise(
      runShip(plan, publish).pipe(
        Effect.provide(
          scriptedShell(calls, (command) =>
            command.startsWith("git rev-parse")
              ? { stdout: "main", exitCode: 0 }
              : command.startsWith("git diff --cached")
                ? { stdout: "", exitCode: 1 } // something is staged
                : command.startsWith("git commit")
                  ? { stdout: "pre-commit hook failed", exitCode: 1 }
                  : { stdout: "", exitCode: 0 },
          ),
        ),
      ),
    )
    expect(Option.isNone(url)).toBe(true)
    expect(calls.some((c) => c.startsWith("git push"))).toBe(false)
    const last = events[events.length - 1]
    expect(last?.type === "ship_step" && !last.ok && last.step === "commit").toBe(true)
  })

  test("a spawn-level ShellError is caught as a failed step, never an exception", async () => {
    const { events, publish } = collect()
    const url = await Effect.runPromise(
      runShip(plan, publish).pipe(
        Effect.provide(
          Layer.succeed(Shell, {
            exec: () => Effect.fail(new ShellError({ message: "spawn git ENOENT" })),
          }),
        ),
      ),
    )
    expect(Option.isNone(url)).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]?.type === "ship_step" && events[0].detail).toContain("ENOENT")
  })
})

describe("the ship step — idempotent re-runs", () => {
  test("a re-run after a FAILED push skips the commit and pushes again", async () => {
    const calls: string[] = []
    const { events, publish } = collect()
    const url = await Effect.runPromise(
      runShip(plan, publish).pipe(
        Effect.provide(
          scriptedShell(calls, (command) =>
            command.startsWith("git rev-parse")
              ? { stdout: "smith/run-22222222\n", exitCode: 0 } // already on the ship branch
              : command.startsWith("git diff --cached")
                ? { stdout: "", exitCode: 0 } // nothing new — the commit exists
                : command.startsWith("gh pr view")
                  ? { stdout: "", exitCode: 1 }
                  : command.startsWith("gh pr create")
                    ? { stdout: "https://github.com/x/y/pull/9\n", exitCode: 0 }
                    : { stdout: "", exitCode: 0 },
          ),
        ),
      ),
    )
    expect(Option.getOrThrow(url)).toBe("https://github.com/x/y/pull/9")
    expect(calls.some((c) => c.startsWith("git checkout"))).toBe(false)
    expect(calls.some((c) => c.startsWith("git commit"))).toBe(false)
    expect(calls.some((c) => c.startsWith("git push"))).toBe(true)
    const commit = events.find((e) => e.type === "ship_step" && e.step === "commit")
    expect(commit?.type === "ship_step" && commit.ok && commit.detail).toContain("reusing")
  })

  test("stage sweeps the tree but NEVER the harness's own state (specs still ship)", async () => {
    const calls: string[] = []
    const { publish } = collect()
    await Effect.runPromise(
      runShip(plan, publish).pipe(
        Effect.provide(scriptedShell(calls, () => ({ stdout: "main", exitCode: 0 }))),
      ),
    )
    const stage = calls.find((c) => c.startsWith("git add")) ?? ""
    expect(stage.startsWith("git add -A -- .")).toBe(true)
    HARNESS_STATE_PATHSPECS.forEach((path) => expect(stage).toContain(`:(exclude)${path}`))
    expect(HARNESS_STATE_PATHSPECS).toContain(".efferent/smith.db")
    expect(HARNESS_STATE_PATHSPECS).toContain(".foundry/runs")
    expect(stage).not.toContain(".efferent/specs")
  })

  test("an already-open PR for the branch is reused — never a second create", async () => {
    const calls: string[] = []
    const { events, publish } = collect()
    const url = await Effect.runPromise(
      runShip(plan, publish).pipe(
        Effect.provide(
          scriptedShell(calls, (command) =>
            command.startsWith("git rev-parse")
              ? { stdout: "main\n", exitCode: 0 }
              : command.startsWith("git diff --cached")
                ? { stdout: "", exitCode: 1 }
                : command.startsWith("gh pr view")
                  ? { stdout: "https://github.com/x/y/pull/4\n", exitCode: 0 }
                  : { stdout: "", exitCode: 0 },
          ),
        ),
      ),
    )
    expect(Option.getOrThrow(url)).toBe("https://github.com/x/y/pull/4")
    expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(false)
    const pr = events.find((e) => e.type === "ship_step" && e.step === "pr")
    expect(pr?.type === "ship_step" && pr.detail).toContain("reused")
  })
})
