import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { fingerprint } from "../domain/baseline.js"
import { GateName, RuleId, WorkspacePath } from "../domain/Brands.js"
import { Finding, SourceLocation } from "../domain/Finding.js"
import type { Gate } from "../ports/Gate.js"
import { withBaselineRatchet } from "./withBaseline.js"

const findingAt = (file: string, line: number, severity: "error" | "warning" = "error") =>
  new Finding({
    rule: RuleId.make("effect/no-let"),
    severity,
    message: "`let` is banned",
    location: Option.some(
      new SourceLocation({ file: WorkspacePath.make(file), line, column: 3 }),
    ),
    fixHint: Option.some("fold instead"),
  })

const constantGate = (findings: ReadonlyArray<Finding>): Gate<never> => ({
  name: GateName.make("effect-idioms"),
  kind: "static",
  deterministic: true,
  run: () => Effect.succeed(findings),
})

describe("withBaselineRatchet", () => {
  test("grandfathered findings are DROPPED; new ones and edited lines stay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-ratchet-"))
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "src", "old.ts"), "const a = 1\n  let grandfathered = 2\n")
    writeFileSync(join(dir, "src", "new.ts"), "  let fresh = 3\n")

    const grandfathered = findingAt("src/old.ts", 2)
    const fresh = findingAt("src/new.ts", 1)
    const baseline = new Set([
      fingerprint(grandfathered, Option.some("  let grandfathered = 2")),
    ])
    const gate = withBaselineRatchet(constantGate([grandfathered, fresh]), baseline)
    const kept = await Effect.runPromise(gate.run({ rootDir: dir, files: [] }))

    expect(kept.length).toBe(1)
    expect(
      Option.match(kept[0]!.location, { onNone: () => "?", onSome: (l) => String(l.file) }),
    ).toBe("src/new.ts")

    // The "touch it, fix it" semantics: editing the grandfathered LINE
    // changes its content fingerprint — the finding is fresh again.
    writeFileSync(join(dir, "src", "old.ts"), "const a = 1\n  let grandfathered = 99\n")
    const afterEdit = await Effect.runPromise(gate.run({ rootDir: dir, files: [] }))
    expect(afterEdit.length).toBe(2)
  })

  test("non-error findings pass through untouched; unreadable files stay STRICT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-ratchet-"))
    const warning = findingAt("src/anything.ts", 1, "warning")
    const missing = findingAt("src/never-written.ts", 1)
    // Even a baseline entry keyed without content can't grandfather the
    // unreadable case unless it matches exactly — this one doesn't.
    const gate = withBaselineRatchet(constantGate([warning, missing]), new Set(["deadbeef"]))
    const kept = await Effect.runPromise(gate.run({ rootDir: dir, files: [] }))
    expect(kept.length).toBe(2)
  })

  test("gate identity is preserved — name, kind, determinism", () => {
    const gate = withBaselineRatchet(constantGate([]), new Set())
    expect(String(gate.name)).toBe("effect-idioms")
    expect(gate.kind).toBe("static")
    expect(gate.deterministic).toBe(true)
  })
})
