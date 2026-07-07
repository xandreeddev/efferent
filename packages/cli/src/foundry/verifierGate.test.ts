import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Layer } from "effect"
import { GateName, runPipeline } from "@xandreed/foundry"
import type { Gate, Workspace } from "@xandreed/foundry"
import { Verifier, VerifierError } from "@xandreed/sdk-core"
import type { DeliverableVerdict } from "@xandreed/sdk-core"
import { makeVerifierJudgeGate } from "./verifierGate.js"

const ws: Workspace = { rootDir: "/tmp/x", files: [] }

const passStatic: Gate<never> = {
  name: GateName.make("effect-idioms"),
  kind: "static",
  deterministic: true,
  run: () => Effect.succeed([]),
}

const fakeVerifier = (verdict: typeof DeliverableVerdict.Type) =>
  Layer.succeed(Verifier, {
    refute: () => Effect.die("refute is not under test"),
    gate: () => Effect.succeed(verdict),
  })

const brokenVerifier = Layer.succeed(Verifier, {
  refute: () => Effect.die("refute is not under test"),
  gate: () => Effect.fail(new VerifierError({ message: "no `claude` binary" })),
})

const judged = makeVerifierJudgeGate({
  task: "implement stringStats",
  summary: "wrote src/stringStats.ts",
  filesChanged: ["src/stringStats.ts"],
})

const pipeline = { gates: Arr.make(passStatic, judged), policy: "staged" as const }

describe("the runtime's Verifier as a foundry rank-4 judge gate", () => {
  test("sound → the pipeline passes; the judge ran last", async () => {
    const report = await Effect.runPromise(
      runPipeline(pipeline, ws).pipe(
        Effect.provide(fakeVerifier({ verdict: "sound", reasons: [] })),
      ),
    )
    expect(report.ok).toBe(true)
    expect(report.verdicts.map((v) => String(v.gate))).toEqual([
      "effect-idioms",
      "deliverable-verifier",
    ])
  })

  test("needs_work → fail with the verifier's reasons as findings", async () => {
    const report = await Effect.runPromise(
      runPipeline(pipeline, ws).pipe(
        Effect.provide(
          fakeVerifier({
            verdict: "needs_work",
            reasons: ["the summary claims a test that does not exist"],
          }),
        ),
      ),
    )
    expect(report.ok).toBe(false)
    const last = report.verdicts[1]!
    expect(
      last._tag === "fail" && last.findings.map((f) => f.message),
    ).toEqual(["the summary claims a test that does not exist"])
  })

  test("an unavailable verifier is a FAIL verdict, never a silent pass", async () => {
    const report = await Effect.runPromise(
      runPipeline(pipeline, ws).pipe(Effect.provide(brokenVerifier)),
    )
    expect(report.ok).toBe(false)
    const last = report.verdicts[1]!
    expect(last._tag === "fail" && last.findings[0].message).toContain("verifier unavailable")
  })
})
