import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Option } from "effect"
import { GateName, RuleId, WorkspacePath } from "../domain/Brands.js"
import { GateCrash } from "../domain/Errors.js"
import { Finding } from "../domain/Finding.js"
import type { Gate, GateKind, Workspace } from "../ports/Gate.js"
import { runPipeline } from "./runPipeline.js"
import type { Pipeline } from "./runPipeline.js"

const ws: Workspace = { rootDir: "/tmp/x", files: [WorkspacePath.make("src/a.ts")] }

const errorFinding = (rule: string) =>
  new Finding({
    rule: RuleId.make(rule),
    severity: "error",
    message: "boom",
    location: Option.none(),
    fixHint: Option.none(),
  })

const fakeGate = (
  name: string,
  kind: GateKind,
  findings: ReadonlyArray<Finding>,
): Gate<never> => ({
  name: GateName.make(name),
  kind,
  deterministic: true,
  run: () => Effect.succeed(findings),
})

const crashingGate = (name: string, kind: GateKind): Gate<never> => ({
  name: GateName.make(name),
  kind,
  deterministic: true,
  run: () => Effect.fail(new GateCrash({ gate: GateName.make(name), message: "tsconfig missing" })),
})

const pipelineOf = (
  gates: ReadonlyArray<Gate<never>>,
  policy: Pipeline<never>["policy"] = "staged",
): Pipeline<never> => {
  expect(Arr.isNonEmptyReadonlyArray(gates)).toBe(true)
  return { gates: gates as Arr.NonEmptyReadonlyArray<Gate<never>>, policy }
}

describe("runPipeline — staged policy", () => {
  test("all green: every gate runs, report ok", async () => {
    const report = await Effect.runPromise(
      runPipeline(
        pipelineOf([
          fakeGate("idioms", "static", []),
          fakeGate("typecheck", "typecheck", []),
          fakeGate("tests", "test", []),
        ]),
        ws,
      ),
    )
    expect(report.ok).toBe(true)
    expect(report.verdicts.map((v) => v._tag)).toEqual(["pass", "pass", "pass"])
  })

  test("a rank-0 failure runs the whole rank but skips later ranks, naming the blocker", async () => {
    const report = await Effect.runPromise(
      runPipeline(
        pipelineOf([
          fakeGate("idioms", "static", [errorFinding("effect/no-let")]),
          fakeGate("boundaries", "static", []),
          fakeGate("typecheck", "typecheck", []),
          fakeGate("tests", "test", []),
        ]),
        ws,
      ),
    )
    expect(report.ok).toBe(false)
    expect(report.verdicts.map((v) => v._tag)).toEqual(["fail", "pass", "skip", "skip"])
    const skip = report.verdicts[2]!
    expect(skip._tag === "skip" && skip.reason.includes("idioms")).toBe(true)
  })

  test("gates are ordered by cost rank regardless of input order", async () => {
    const report = await Effect.runPromise(
      runPipeline(
        pipelineOf([
          fakeGate("tests", "test", []),
          fakeGate("idioms", "static", []),
          fakeGate("typecheck", "typecheck", []),
        ]),
        ws,
      ),
    )
    expect(report.verdicts.map((v) => String(v.gate))).toEqual([
      "idioms",
      "typecheck",
      "tests",
    ])
  })

  test("a crashing gate folds to fail-closed, never a silent pass", async () => {
    const report = await Effect.runPromise(
      runPipeline(pipelineOf([crashingGate("idioms", "static")]), ws),
    )
    expect(report.ok).toBe(false)
    const verdict = report.verdicts[0]
    expect(verdict._tag).toBe("fail")
    expect(
      verdict._tag === "fail" && String(verdict.findings[0].rule),
    ).toBe("foundry/gate-crashed")
  })

  test("a defect (thrown from inside a gate) also folds fail-closed", async () => {
    const dying: Gate<never> = {
      name: GateName.make("idioms"),
      kind: "static",
      deterministic: true,
      run: () => Effect.dieMessage("unexpected"),
    }
    const report = await Effect.runPromise(runPipeline(pipelineOf([dying]), ws))
    expect(report.ok).toBe(false)
  })
})

describe("runPipeline — other policies", () => {
  test("fail-fast: first failure skips EVERYTHING after it, same rank included", async () => {
    const report = await Effect.runPromise(
      runPipeline(
        pipelineOf(
          [
            fakeGate("idioms", "static", [errorFinding("effect/no-let")]),
            fakeGate("boundaries", "static", []),
          ],
          "fail-fast",
        ),
        ws,
      ),
    )
    expect(report.verdicts.map((v) => v._tag)).toEqual(["fail", "skip"])
  })

  test("collect-all: everything runs despite failures", async () => {
    const report = await Effect.runPromise(
      runPipeline(
        pipelineOf(
          [
            fakeGate("idioms", "static", [errorFinding("effect/no-let")]),
            fakeGate("tests", "test", []),
          ],
          "collect-all",
        ),
        ws,
      ),
    )
    expect(report.verdicts.map((v) => v._tag)).toEqual(["fail", "pass"])
  })
})
