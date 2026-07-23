import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Ref, TestClock, TestContext } from "effect"
import { GateName, WorkspacePath } from "../domain/Brands.js"
import { GateCrash } from "../domain/Errors.js"
import type { Workspace } from "../ports/Gate.js"
import { makeJudgeGate } from "./judgeGate.js"

const ws: Workspace = { rootDir: "/tmp/x", files: [WorkspacePath.make("src/a.ts")] }

describe("makeJudgeGate", () => {
  test("a transiently-failing judge is retried and never spends the attempt (task #110)", async () => {
    const program = Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const gate = makeJudgeGate("verifier", () =>
        Ref.updateAndGet(calls, (n) => n + 1).pipe(
          Effect.flatMap((n) =>
            n < 3
              ? Effect.fail(new GateCrash({ gate: GateName.make("verifier"), message: "OpenCode.generateText: TimeoutError" }))
              : Effect.succeed({ sound: true, reasons: [] }),
          ),
        ))
      const fiber = yield* Effect.fork(gate.run(ws))
      yield* TestClock.adjust("30 seconds")
      const findings = yield* Fiber.join(fiber)
      expect(findings).toEqual([])
      expect(yield* Ref.get(calls)).toBe(3)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)))
  })

  test("retries exhausted still crash fail-closed", async () => {
    const program = Effect.gen(function* () {
      const gate = makeJudgeGate("verifier", () =>
        Effect.fail(new GateCrash({ gate: GateName.make("verifier"), message: "hard down" })))
      const fiber = yield* Effect.fork(Effect.exit(gate.run(ws)))
      yield* TestClock.adjust("60 seconds")
      const exit = yield* Fiber.join(fiber)
      expect(exit._tag).toBe("Failure")
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)))
  })
})
