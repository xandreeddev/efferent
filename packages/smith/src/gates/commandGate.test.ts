import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Option } from "effect"
import { runPipeline } from "@xandreed/foundry"
import type { Workspace } from "@xandreed/foundry"
import { makeCommandGate } from "./commandGate.js"

const ws: Workspace = { rootDir: process.cwd(), files: [] }

describe("makeCommandGate", () => {
  test("exit 0 → no findings", async () => {
    const gate = makeCommandGate({ name: "ok", argv: ["bun", "-e", "process.exit(0)"] })
    const findings = await Effect.runPromise(gate.run(ws))
    expect(findings).toEqual([])
    expect(gate.kind).toBe("test")
    expect(gate.deterministic).toBe(true)
  })

  test("non-zero exit → located finding from file:line output + clipped summary", async () => {
    const gate = makeCommandGate({
      name: "fails",
      argv: [
        "bun",
        "-e",
        "console.error('src/foo.ts:12: expected 2, got 3'); process.exit(1)",
      ],
    })
    const findings = await Effect.runPromise(gate.run(ws))
    expect(findings.length).toBe(2)
    const located = findings[0]!
    expect(String(located.rule)).toBe("test/fails")
    expect(Option.getOrThrow(located.location).line).toBe(12)
    expect(String(Option.getOrThrow(located.location).file)).toBe("src/foo.ts")
    const summary = findings[1]!
    expect(summary.message).toContain("exited 1")
    expect(Option.getOrThrow(summary.fixHint)).toContain("pass")
  })

  test("no parseable locations → exactly one summary finding", async () => {
    const gate = makeCommandGate({
      name: "opaque",
      argv: ["bun", "-e", "console.error('everything is broken'); process.exit(3)"],
    })
    const findings = await Effect.runPromise(gate.run(ws))
    expect(findings.length).toBe(1)
    expect(findings[0]!.message).toContain("everything is broken")
  })

  test("an unspawnable command is a GateCrash — folded FAIL-CLOSED by the pipeline", async () => {
    const gate = makeCommandGate({
      name: "ghost",
      argv: ["definitely-not-a-real-binary-xyz"],
    })
    const report = await Effect.runPromise(
      runPipeline({ gates: Arr.of(gate), policy: "collect-all" }, ws),
    )
    expect(report.ok).toBe(false)
    const verdict = report.verdicts[0]!
    expect(verdict._tag).toBe("fail")
  })
})
