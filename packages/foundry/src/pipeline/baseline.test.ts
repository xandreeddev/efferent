import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { RuleId, WorkspacePath } from "../domain/Brands.js"
import { Finding, SourceLocation } from "../domain/Finding.js"
import { diffAgainstBaseline, fingerprint } from "./baseline.js"

const finding = (rule: string, file: string, line: number) =>
  new Finding({
    rule: RuleId.make(rule),
    severity: "error",
    message: "boom",
    location: Option.some(
      new SourceLocation({ file: WorkspacePath.make(file), line, column: 1 }),
    ),
    fixHint: Option.none(),
  })

describe("baseline fingerprints", () => {
  test("keyed on line CONTENT, not line number — edits above don't churn", () => {
    const f1 = finding("effect/no-let", "src/a.ts", 10)
    const f2 = finding("effect/no-let", "src/a.ts", 99)
    const line = Option.some("  let total = 0")
    expect(fingerprint(f1, line)).toBe(fingerprint(f2, line))
    // …but whitespace-only reformatting doesn't churn either.
    expect(fingerprint(f1, Option.some("let   total = 0  "))).toBe(fingerprint(f1, line))
  })

  test("different rule or file or content → different fingerprint", () => {
    const f = finding("effect/no-let", "src/a.ts", 10)
    const line = Option.some("let total = 0")
    expect(fingerprint(f, line)).not.toBe(fingerprint(f, Option.some("let other = 1")))
    expect(fingerprint(f, line)).not.toBe(
      fingerprint(finding("effect/no-let", "src/b.ts", 10), line),
    )
    expect(fingerprint(f, line)).not.toBe(
      fingerprint(finding("effect/no-as-any", "src/a.ts", 10), line),
    )
  })

  test("diff: baselined findings are grandfathered, fresh ones surface", () => {
    const old = finding("effect/no-let", "src/a.ts", 10)
    const fresh = finding("effect/no-as-any", "src/a.ts", 20)
    const entries = [
      { finding: old, fingerprint: fingerprint(old, Option.some("let x = 1")) },
      { finding: fresh, fingerprint: fingerprint(fresh, Option.some("y as any")) },
    ]
    const diff = diffAgainstBaseline(entries, new Set([entries[0]!.fingerprint]))
    expect(diff.fresh.map((f) => f.finding.rule)).toEqual([RuleId.make("effect/no-as-any")])
    expect(diff.current.length).toBe(2)
  })
})
