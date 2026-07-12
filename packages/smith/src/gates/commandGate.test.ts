import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  test("an eval command keeps its cost rank and finding namespace", async () => {
    const gate = makeCommandGate({
      name: "scenarios",
      kind: "eval",
      argv: ["bun", "-e", "process.exit(1)"],
    })
    const findings = await Effect.runPromise(gate.run(ws))
    expect(gate.kind).toBe("eval")
    expect(String(findings[0]!.rule)).toBe("eval/scenarios")
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

  test("a tool provisioned into <ws>/.local/bin COUNTS — the gate sees the coder's toolchain", async () => {
    // The zig-run lesson: the coder built its own toolchain into
    // .local/bin, self-verified green, and every gate still 127'd because
    // the gate env diverged. This pins the parity: same prefix, same PATH.
    const dir = mkdtempSync(join(tmpdir(), "gate-toolchain-"))
    mkdirSync(join(dir, ".local", "bin"), { recursive: true })
    const tool = join(dir, ".local", "bin", "claw-fake-tool")
    writeFileSync(tool, "#!/usr/bin/env bash\necho provisioned-ok\n")
    chmodSync(tool, 0o755)
    const gate = makeCommandGate({
      name: "provisioned",
      argv: ["bash", "-c", "claw-fake-tool | grep -q provisioned-ok"],
    })
    const findings = await Effect.runPromise(gate.run({ rootDir: dir, files: [] }))
    expect(findings).toEqual([])
  })

  test("exit 127 (tool missing) is an ENVIRONMENT finding — env/ rule, honest fixHint", async () => {
    const gate = makeCommandGate({
      name: "zig-build",
      argv: ["bash", "-c", "definitely-not-installed-tool build"],
    })
    const findings = await Effect.runPromise(gate.run(ws))
    expect(findings.length).toBe(1)
    const finding = findings[0]!
    expect(String(finding.rule)).toBe("env/zig-build")
    expect(finding.message).toContain("ENVIRONMENT:")
    expect(finding.message).toContain("command not found")
    const hint = Option.getOrThrow(finding.fixHint)
    // The old hint said "make it pass" — unfixable by editing code; the new
    // one names the actual fix (the zig-run lesson).
    expect(hint).toContain(".local/bin")
    expect(hint).not.toContain("make")
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
