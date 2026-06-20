import { describe, expect, it } from "bun:test"
import { FastCheck as fc } from "effect"
import {
  planContentCompression,
  planLogCompression,
  planSearchCompression,
} from "./compactionContent.js"

// ─── fixtures ────────────────────────────────────────────────────────────────

/** 50 files × 40 matches each — a classic grep flood (~2000 lines). */
const grepFlood = (): string => {
  const lines: string[] = []
  for (let f = 0; f < 50; f++) {
    for (let m = 0; m < 40; m++) {
      lines.push(`src/pkg${f}/file${f}.ts:${m + 10}: const value${m} = useThing("${f}-${m}")`)
    }
  }
  return lines.join("\n")
}

/** A build/test log: banner, noise, a buried failure with a stack, summary. */
const buildLog = (): string => {
  const lines: string[] = ["$ bun test", "bun test v1.3.0", ""]
  for (let i = 0; i < 400; i++) lines.push(`compiling module_${i}.ts … ok`)
  lines.push("warning: deprecated API used in legacy.ts")
  for (let i = 400; i < 800; i++) lines.push(`compiling module_${i}.ts … ok`)
  lines.push("warning: deprecated API used in legacy.ts")
  lines.push("test src/foo.test.ts:")
  lines.push("✗ folds the thing FAIL")
  lines.push("error: expect(received).toBe(expected)")
  lines.push("    at foldThing (src/foo.ts:42:11)")
  lines.push("    at <anonymous> (src/foo.test.ts:17:5)")
  for (let i = 800; i < 1200; i++) lines.push(`compiling module_${i}.ts … ok`)
  lines.push(" 199 pass")
  lines.push(" 1 fail")
  lines.push("Ran 200 tests across 53 files. [2.50s]")
  return lines.join("\n")
}

// ─── search ──────────────────────────────────────────────────────────────────

describe("planSearchCompression", () => {
  it("groups a grep flood by file: every file visible, capped per file, in budget", () => {
    const text = grepFlood()
    const plan = planSearchCompression(text, 16_000)!
    expect(plan.kind).toBe("search")
    expect(plan.kept.length).toBeLessThanOrEqual(16_000)
    // Files that fit show a header with total + shown counts.
    expect(plan.kept).toContain("src/pkg0/file0.ts (40 matches, showing 5)")
    // First match of a shown file survives (content kept verbatim after the lineno).
    expect(plan.kept).toContain('  10:  const value0 = useThing("0-0")')
    // The marker math names the full corpus.
    expect(plan.summary).toContain("of 2000 matched lines omitted")
    expect(plan.summary).toContain("(50 files,")
    expect(plan.hint).toContain("narrower")
    expect(plan.omitted).toBe("") // no digest for homogeneous matches
  })

  it("rejects non-search shapes", () => {
    // Timestamps parse as NN:NN but have no path-like prefix.
    const timestamps = Array.from({ length: 50 }, (_, i) => `12:0${i % 10}:33 starting worker`).join("\n")
    expect(planSearchCompression(timestamps, 1000)).toBeUndefined()
    // Too few matches.
    expect(planSearchCompression("src/a.ts:1: x\nsrc/b.ts:2: y", 10)).toBeUndefined()
    // Mostly prose with a couple of path:line mentions.
    const prose = Array.from({ length: 100 }, (_, i) =>
      i % 10 === 0 ? `src/a.ts:${i}: hit` : `some explanatory prose line number ${i}`,
    ).join("\n")
    expect(planSearchCompression(prose, 1000)).toBeUndefined()
  })

  it("accepts grep -C context lines (path-NN- shape) as part of the corpus", () => {
    const withContext = Array.from({ length: 60 }, (_, i) =>
      i % 3 === 1 ? `src/x.ts:${i}: the match` : `src/x.ts-${i}- context line`,
    ).join("\n")
    const plan = planSearchCompression(withContext, 4000)!
    expect(plan.kept).toContain("src/x.ts")
  })
})

// ─── logs ────────────────────────────────────────────────────────────────────

describe("planLogCompression", () => {
  it("keeps head, error block with trace, deduped warnings, summaries, tail", () => {
    const plan = planLogCompression(buildLog(), 16_000)!
    expect(plan.kind).toBe("log")
    expect(plan.kept).toContain("$ bun test") // head
    expect(plan.kept).toContain("✗ folds the thing FAIL") // the error
    expect(plan.kept).toContain("at foldThing (src/foo.ts:42:11)") // trace intact
    expect(plan.kept).toContain("warning: deprecated API used in legacy.ts  (×2)") // deduped
    expect(plan.kept).toContain(" 1 fail") // summary
    expect(plan.kept).toContain("Ran 200 tests") // tail
    expect(plan.kept).toContain("lines omitted…]") // gap markers
    expect(plan.kept.length).toBeLessThan(16_000)
    // The omitted bulk is available for the fast digest.
    expect(plan.omitted).toContain("compiling module_")
    expect(plan.summary).toContain("log lines omitted")
  })

  it("a signal-less log is not structurally compressed (blind clip territory)", () => {
    const quiet = Array.from({ length: 200 }, (_, i) => `copying asset ${i}`).join("\n")
    expect(planLogCompression(quiet, 1000)).toBeUndefined()
  })

  it("short outputs are left to the clip", () => {
    expect(planLogCompression("error: nope", 10)).toBeUndefined()
  })

  it("stays within budget even with many error blocks", () => {
    const noisy = Array.from({ length: 2000 }, (_, i) =>
      i % 4 === 0 ? `error: failure number ${i} occurred` : `line ${i}`,
    ).join("\n")
    const plan = planLogCompression(noisy, 4000)!
    expect(plan.kept.length).toBeLessThanOrEqual(4500)
  })
})

// ─── routing ─────────────────────────────────────────────────────────────────

describe("planContentCompression", () => {
  it("routes search shape from any tool; log shape only from Bash", () => {
    expect(planContentCompression(grepFlood(), "grep", 16_000)?.kind).toBe("search")
    expect(planContentCompression(grepFlood(), "Bash", 16_000)?.kind).toBe("search")
    expect(planContentCompression(buildLog(), "Bash", 16_000)?.kind).toBe("log")
    // A web page mentioning "error" must NOT get log treatment.
    expect(planContentCompression(buildLog(), "web_fetch", 16_000)).toBeUndefined()
  })
})

// ─── properties ──────────────────────────────────────────────────────────────

const joinedLinesArb = fc
  .array(fc.oneof(fc.string({ maxLength: 80 }), fc.fullUnicodeString({ maxLength: 80 })), {
    maxLength: 120,
  })
  .map((ls) => ls.join("\n"))

describe("properties — planSearchCompression", () => {
  it("is total: never throws on arbitrary text; result is undefined or a search plan", () => {
    fc.assert(
      fc.property(joinedLinesArb, fc.integer({ min: 0, max: 30_000 }), (text, maxChars) => {
        const plan = planSearchCompression(text, maxChars)
        if (plan !== undefined) expect(plan.kind).toBe("search")
      }),
      { numRuns: 200 },
    )
  })

  it("constructed corpora: kept lines come from the input, budget holds, counts add up", () => {
    const matchArb = fc.record({
      file: fc.stringMatching(/^[a-z]{1,8}$/).map((w) => `src/${w}.ts`),
      lineNo: fc.integer({ min: 1, max: 9999 }),
      text: fc.string({ maxLength: 200 }).map((t) => t.replace(/[\r\n]/g, " ")),
    })
    fc.assert(
      fc.property(
        fc.array(matchArb, { minLength: 20, maxLength: 150 }),
        fc.integer({ min: 2000, max: 20_000 }),
        (matches, maxChars) => {
          const text = matches.map((m) => `${m.file}:${m.lineNo}:${m.text}`).join("\n")
          const plan = planSearchCompression(text, maxChars)
          expect(plan).toBeDefined()
          const kept = plan!.kept
          // The loop always admits the FIRST file block even over budget —
          // one block here is ≤ ~1600 chars (header + 5 × ~250-char lines).
          expect(kept.length).toBeLessThanOrEqual(Math.floor(maxChars * 0.9) + 1600)
          const bodyLines = kept.split("\n").filter((l) => /^  \d+: /.test(l))
          for (const line of bodyLines) {
            expect(text).toContain(line.replace(/^  (\d+): /, ""))
          }
          const m = /^(\d+) of (\d+) matched lines omitted \((\d+) files, (\d+) shown/.exec(
            plan!.summary,
          )!
          expect(m).not.toBeNull()
          const [, omitted, total, files, shown] = m.map(Number)
          expect(total).toBe(matches.length)
          expect(omitted).toBe(total! - bodyLines.length)
          expect(files).toBe(new Set(matches.map((x) => x.file)).size)
          const headerLines = kept.split("\n").filter((l) => / match(es)?\b|matches,/.test(l) && !l.startsWith("  "))
          expect(shown).toBe(headerLines.length)
        },
      ),
      { numRuns: 100 },
    )
  })

  it("fewer than 20 matched lines never fires", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 99 }).map((n) => `src/a.ts:${n}:hit`), { maxLength: 19 }),
        (lines) => {
          expect(planSearchCompression(lines.join("\n"), 10)).toBeUndefined()
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe("properties — planLogCompression", () => {
  it("is total: never throws on arbitrary text", () => {
    fc.assert(
      fc.property(joinedLinesArb, fc.integer({ min: 0, max: 30_000 }), (text, maxChars) => {
        const plan = planLogCompression(text, maxChars)
        if (plan !== undefined) expect(plan.kind).toBe("log")
      }),
      { numRuns: 200 },
    )
  })

  it("kept lines are gap markers or input lines; gap arithmetic accounts for every line", () => {
    // Filler from a constant word pool that cannot match ERROR/WARN/SUMMARY/TRACE.
    const fillerArb = fc.array(
      fc.tuple(fc.constantFrom("alpha", "bravo", "delta", "lorem"), fc.integer({ min: 0, max: 999 }))
        .map(([w, n]) => `${w} item ${n}`),
      { minLength: 40, maxLength: 200 },
    )
    fc.assert(
      fc.property(fillerArb, fc.integer({ min: 0, max: 30 }), (filler, errPos) => {
        const lines = [...filler]
        const at = Math.min(errPos, lines.length - 2)
        lines.splice(at, 0, "Error: token-xyz boom", "    at fn (x.ts:1:1)")
        const text = lines.join("\n")
        const plan = planLogCompression(text, 2 * text.length + 100)
        expect(plan).toBeDefined()
        const inputLines = new Set(lines)
        let gapSum = 0
        let keptCount = 0
        for (const line of plan!.kept.split("\n")) {
          const gap = /^  \[…(\d+) lines omitted…\]$/u.exec(line)
          if (gap !== null) {
            gapSum += Number(gap[1])
            continue
          }
          keptCount++
          const stripped = line.replace(/  \(×\d+\)$/u, "")
          expect(inputLines.has(line) || inputLines.has(stripped)).toBe(true)
        }
        expect(gapSum + keptCount).toBe(lines.length)
        // The error block survives intact under a generous budget.
        expect(plan!.kept).toContain("Error: token-xyz boom")
        expect(plan!.kept).toContain("    at fn (x.ts:1:1)")
      }),
      { numRuns: 100 },
    )
  })
})
