import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { SpecDoc } from "@xandreed/engine"
import { listCases } from "../live/fixtures.js"
import {
  lastSpecGradesJson,
  makeSpecQualityJudge,
  specGradesToScore,
} from "../judges/specQuality.js"
import {
  bounceCount,
  hasAssumptionBullet,
  mentionsNeedles,
  multilineChecks,
  readRefinerCase,
  refinerPack,
  vacuousDraftChecks,
} from "./refiner.js"

/** The key-free half of E3: fixture decodes, pack shape, and the
 *  deterministic check logic proven without a session or a key. */

const FIXTURES = join(import.meta.dir, "..", "..", "..", "smith", "fixtures", "refiner-golden")

const doc = (over: Partial<Parameters<typeof SpecDoc.make>[0]> = {}) =>
  Schema.decodeUnknownSync(SpecDoc)({
    slug: "toy-spec",
    status: "draft",
    created: "2026-07-10T00:00:00.000Z",
    goal: "Create out.txt containing done.",
    acceptance: ["out.txt exists"],
    constraints: [],
    nonGoals: [],
    checks: [{ name: "out-content", command: "grep -q done out.txt" }],
    limits: { maxAttempts: 3, budgetMinutes: 15 },
    gates: {},
    ...over,
  })

describe("refiner fixtures + pack shape", () => {
  test("every refiner-golden case decodes", async () => {
    const cases = listCases(FIXTURES)
    expect(cases.length).toBe(5)
    await Effect.runPromise(
      Effect.forEach(cases, (name) => readRefinerCase(FIXTURES, name)),
    )
  })

  test("pack: live-only, k=2, versioned, tolerant", () => {
    expect(refinerPack.scenarios).toHaveLength(5)
    expect(refinerPack.samples).toBe(2)
    expect(refinerPack.tolerance).toBe(0.1)
    expect(refinerPack.meta?.["refiner-prompt"]).toBeDefined()
  })
})

describe("the deterministic check logic", () => {
  test("multilineChecks flags embedded newlines", () => {
    expect(multilineChecks(doc())).toEqual([])
    expect(
      multilineChecks(doc({ checks: [{ name: "bad", command: "a\nb" }] })),
    ).toEqual(["bad"])
  })

  test("vacuousDraftChecks: a green check is flagged, a red one is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "refiner-redfirst-"))
    writeFileSync(join(dir, "exists.txt"), "already here\n")
    const vacuous = await Effect.runPromise(
      vacuousDraftChecks(
        doc({
          checks: [
            { name: "green", command: "test -f exists.txt" },
            { name: "red", command: "test -f missing.txt" },
          ],
        }),
        dir,
      ),
    )
    expect(vacuous).toEqual(["green"])
  })

  test("bounceCount counts propose_spec isError results only", () => {
    const messages = [
      { role: "user" as const, content: "idea" },
      {
        role: "tool" as const,
        content: [
          { type: "tool-result" as const, toolCallId: "1", toolName: "propose_spec", isError: true, output: {} },
          { type: "tool-result" as const, toolCallId: "2", toolName: "read_file", isError: true, output: {} },
          { type: "tool-result" as const, toolCallId: "3", toolName: "propose_spec", isError: false, output: {} },
        ],
      },
    ]
    expect(bounceCount(messages)).toBe(1)
  })

  test("mentionsNeedles searches the whole doc, case-insensitive", () => {
    const draft = doc({ goal: "Create the Slugify module.", nonGoals: ["no CLI"] })
    expect(mentionsNeedles(draft, ["slugify", "cli"])).toEqual([])
    expect(mentionsNeedles(draft, ["database"])).toEqual(["database"])
  })

  test("hasAssumptionBullet requires the prefix", () => {
    expect(hasAssumptionBullet(doc({ constraints: ["assumption: errors mean the fetch layer"] }))).toBe(true)
    expect(hasAssumptionBullet(doc({ constraints: ["never delete files"] }))).toBe(false)
  })
})

describe("the spec-quality judge", () => {
  test("canned grades → Σ/20 with per-axis reason; grades parse from noisy replies", async () => {
    const judge = makeSpecQualityJudge<{ readonly d: SpecDoc }>({
      doc: (world) => Effect.succeed(world.d),
      call: () =>
        Effect.succeed(
          `reasoning first {"goal": 2} then the verdict\n{"goal": 5, "acceptance": 4, "constraints": 5, "scope": 4, "summary": "tight spec"}`,
        ),
    })
    const verdict = await Effect.runPromise(judge.run({ d: doc() }))
    expect(verdict.score).toBeCloseTo(18 / 20, 5)
    expect(verdict.reason).toContain("tight spec")
    expect(verdict.reason).toContain("acceptance 4/5")
  })

  test("specGradesToScore + lastSpecGradesJson pure behavior", () => {
    expect(
      specGradesToScore({ goal: 5, acceptance: 5, constraints: 5, scope: 5, summary: "" }),
    ).toBe(1)
    expect(lastSpecGradesJson('x {"goal": 1, ...} y {"goal": 3, "acceptance": 3}')).toContain(
      '"goal": 3',
    )
  })
})
