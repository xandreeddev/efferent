import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { AttemptNumber, GateName, RuleId, WorkspacePath } from "../domain/Brands.js"
import { Finding, SourceLocation } from "../domain/Finding.js"
import { FailVerdict, GateReport, SkipVerdict } from "../domain/Verdict.js"
import { renderFeedback } from "./renderFeedback.js"

const finding = (rule: string, file: string, line: number, message: string, hint?: string) =>
  new Finding({
    rule: RuleId.make(rule),
    severity: "error",
    message,
    location: Option.some(
      new SourceLocation({ file: WorkspacePath.make(file), line, column: 3 }),
    ),
    fixHint: hint === undefined ? Option.none() : Option.some(hint),
  })

describe("renderFeedback", () => {
  test("golden: deterministic, grouped per gate, sorted by file/line, skip note present", () => {
    const report = new GateReport({
      verdicts: [
        FailVerdict.make({
          gate: GateName.make("effect-idioms"),
          durationMs: 40,
          findings: [
            // Deliberately out of order — the renderer must sort.
            finding("effect/no-nullable-return", "src/stringStats.ts", 30, "returns `string | undefined`; return Option<string>", "wrap with Option.fromNullable"),
            finding("effect/no-let", "src/stringStats.ts", 12, "`let` is banned; fold state instead", "use Effect.iterate or Array combinators"),
          ],
        }),
        SkipVerdict.make({
          gate: GateName.make("typecheck"),
          reason: "blocked: an earlier stage failed (effect-idioms)",
        }),
      ],
    })

    const rendered = renderFeedback(report, AttemptNumber.make(2))
    expect(rendered).toBe(
      [
        "The deterministic gate pipeline rejected attempt 2. Fix every item below; the work will be re-checked.",
        "",
        "## gate: effect-idioms — 2 errors",
        "- [effect/no-let] src/stringStats.ts:12:3 — `let` is banned; fold state instead. Fix: use Effect.iterate or Array combinators",
        "- [effect/no-nullable-return] src/stringStats.ts:30:3 — returns `string | undefined`; return Option<string>. Fix: wrap with Option.fromNullable",
        "",
        "Not yet run (blocked by the failures above): typecheck.",
      ].join("\n"),
    )
    // Determinism: same input, byte-identical output.
    expect(renderFeedback(report, AttemptNumber.make(2))).toBe(rendered)
  })

  test("caps per-gate findings with an exact overflow count", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      finding("effect/no-let", "src/big.ts", i + 1, "`let` is banned"),
    )
    const report = new GateReport({
      verdicts: [
        FailVerdict.make({
          gate: GateName.make("effect-idioms"),
          durationMs: 1,
          findings: [many[0]!, ...many.slice(1)],
        }),
      ],
    })
    const rendered = renderFeedback(report, AttemptNumber.make(1))
    expect(rendered).toContain("…and 5 more from this gate")
    expect(rendered.match(/- \[effect\/no-let\]/g)?.length).toBe(20)
  })
})
