import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { GateName, RuleId, WorkspacePath } from "./Brands.js"
import { Finding, SourceLocation } from "./Finding.js"
import { GateReport, toVerdict } from "./Verdict.js"

const gate = GateName.make("effect-idioms")

const finding = (severity: "error" | "warning" | "info") =>
  new Finding({
    rule: RuleId.make("effect/no-let"),
    severity,
    message: "`let` is banned",
    location: Option.some(
      new SourceLocation({ file: WorkspacePath.make("src/a.ts"), line: 3, column: 1 }),
    ),
    fixHint: Option.none(),
  })

describe("toVerdict — the one classification rule", () => {
  test("no findings → pass", () => {
    const v = toVerdict(gate, 12, [])
    expect(v._tag).toBe("pass")
  })

  test("warnings/info only → pass, findings carried as advisory", () => {
    const v = toVerdict(gate, 12, [finding("warning"), finding("info")])
    expect(v._tag).toBe("pass")
    expect(v._tag === "pass" && v.findings.length).toBe(2)
  })

  test("any error-severity finding → fail, and fail carries ONLY the errors", () => {
    const v = toVerdict(gate, 12, [finding("warning"), finding("error")])
    expect(v._tag).toBe("fail")
    expect(v._tag === "fail" && v.findings.length).toBe(1)
  })
})

describe("GateReport", () => {
  test("ok derives from the absence of fail verdicts", () => {
    const pass = toVerdict(gate, 1, [])
    const fail = toVerdict(gate, 1, [finding("error")])
    expect(new GateReport({ verdicts: [pass] }).ok).toBe(true)
    expect(new GateReport({ verdicts: [pass, fail] }).ok).toBe(false)
  })
})

describe("Finding wire shape", () => {
  test("Option absence encodes to an omitted field and round-trips", () => {
    const f = new Finding({
      rule: RuleId.make("ts/2322"),
      severity: "error",
      message: "Type 'number' is not assignable to type 'string'.",
      location: Option.none(),
      fixHint: Option.none(),
    })
    const encoded = Schema.encodeSync(Finding)(f)
    expect("location" in encoded).toBe(false)
    expect("fixHint" in encoded).toBe(false)
    const decoded = Schema.decodeSync(Finding)(encoded)
    expect(Option.isNone(decoded.location)).toBe(true)
    expect(decoded.message).toBe(f.message)
  })
})
