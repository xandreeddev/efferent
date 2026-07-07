import { describe, expect, test } from "bun:test"
import { Effect, FastCheck as fc, Option } from "effect"
import {
  DEFAULT_SPEC_LIMITS,
  renderSpecSection,
  SpecCheck,
  SpecDoc,
  SpecGates,
  SpecLimits,
  SpecSlug,
} from "../entities/SpecDoc.js"
import {
  decodeSpecDocText,
  encodeSpecDocText,
  SpecDocParseError,
  specSlug,
  uniqueSlug,
} from "./specCodec.js"

const fullDoc = new SpecDoc({
  slug: SpecSlug.make("stats-util"),
  status: "locked",
  created: "2026-07-07T10:00:00Z",
  locked: Option.some("2026-07-07T11:00:00Z"),
  goal: "Implement a stats module exporting mean and median with tests.",
  acceptance: ["mean handles the empty list via Option", "median covers odd and even lengths"],
  constraints: ["do not touch existing exports"],
  nonGoals: ["no CLI surface"],
  checks: [new SpecCheck({ name: "stats-tests", command: "bun test src/stats.test.ts" })],
  limits: new SpecLimits({ maxAttempts: 4, budgetMinutes: 20 }),
  gates: new SpecGates({
    config: Option.some("foundry.config.ts"),
    testCommand: Option.some("bun test"),
    noTest: false,
  }),
})

const minimalDoc = new SpecDoc({
  slug: SpecSlug.make("tiny"),
  status: "draft",
  created: "2026-07-07T10:00:00Z",
  locked: Option.none(),
  goal: "Do the small thing.",
  acceptance: [],
  constraints: [],
  nonGoals: [],
  checks: [],
  limits: DEFAULT_SPEC_LIMITS,
  gates: new SpecGates({ config: Option.none(), testCommand: Option.none(), noTest: false }),
})

const roundTrip = (doc: SpecDoc): SpecDoc =>
  Effect.runSync(decodeSpecDocText(doc.slug, encodeSpecDocText(doc)))

describe("spec codec — round trip", () => {
  test("full document survives encode→decode exactly", () => {
    expect(roundTrip(fullDoc)).toEqual(fullDoc)
  })

  test("minimal document survives (absent options stay absent)", () => {
    const decoded = roundTrip(minimalDoc)
    expect(decoded).toEqual(minimalDoc)
    expect(Option.isNone(decoded.locked)).toBe(true)
    expect(Option.isNone(decoded.gates.config)).toBe(true)
  })

  test("property: grammar-safe docs always round-trip", () => {
    const safeLine = fc
      .string({ minLength: 1, maxLength: 60, unit: "grapheme-ascii" })
      .map((s) => s.replace(/[\n\r#:-]/g, "x").trim())
      .filter((s) => s.length > 0)
    fc.assert(
      fc.property(
        safeLine,
        fc.array(safeLine, { maxLength: 4 }),
        fc.array(safeLine, { maxLength: 3 }),
        fc.integer({ min: 1, max: 10 }),
        fc.boolean(),
        (goal, acceptance, constraints, maxAttempts, noTest) => {
          const doc = new SpecDoc({
            slug: SpecSlug.make("prop"),
            status: "draft",
            created: "2026-07-07T10:00:00Z",
            locked: Option.none(),
            goal,
            acceptance,
            constraints,
            nonGoals: [],
            checks: [],
            limits: new SpecLimits({ maxAttempts, budgetMinutes: 15 }),
            gates: new SpecGates({
              config: Option.none(),
              testCommand: Option.none(),
              noTest,
            }),
          })
          expect(roundTrip(doc)).toEqual(doc)
        },
      ),
      { numRuns: 50 },
    )
  })
})

describe("spec codec — strictness (typed errors, never silent drift)", () => {
  const decodeFail = (text: string): SpecDocParseError =>
    Effect.runSync(
      decodeSpecDocText("x", text).pipe(Effect.flip),
    )

  test("missing frontmatter", () => {
    expect(decodeFail("# Goal\nDo it.").message).toContain("frontmatter")
  })

  test("unknown section header", () => {
    const text = "---\nstatus: draft\ncreated: t\n---\n# Goal\nDo.\n\n## Surprises\n- nope\n"
    expect(decodeFail(text).message).toContain("Surprises")
  })

  test("prose inside a bullet section", () => {
    const text = "---\nstatus: draft\ncreated: t\n---\n# Goal\nDo.\n\n## Acceptance\nnot a bullet\n"
    expect(decodeFail(text).message).toContain("bullets")
  })

  test("missing goal", () => {
    const text = "---\nstatus: draft\ncreated: t\n---\n## Acceptance\n- a\n"
    expect(decodeFail(text).message).toContain("Goal")
  })

  test("check bullet without a colon", () => {
    const text = "---\nstatus: draft\ncreated: t\n---\n# Goal\nDo.\n\n## Checks\n- just-a-name\n"
    expect(decodeFail(text).message).toContain("name: command")
  })

  test("a draft never lies about being locked (schema bounds enforced)", () => {
    const text = "---\nstatus: shipped\ncreated: t\n---\n# Goal\nDo.\n"
    expect(decodeFail(text).message).toContain("shipped")
  })
})

describe("encode stays inside its own grammar", () => {
  test("prose bullets with embedded newlines are normalized, and round-trip", () => {
    const messy = new SpecDoc({
      ...minimalDoc,
      acceptance: ["line one\n  wrapped onto line two", "  padded  "],
      constraints: ["a\n\nb"],
    })
    const decoded = roundTrip(messy)
    expect(decoded.acceptance).toEqual(["line one wrapped onto line two", "padded"])
    expect(decoded.constraints).toEqual(["a b"])
  })
})

describe("slugs", () => {
  test("specSlug is deterministic kebab, truncated", () => {
    expect(String(specSlug("Implement a Stats Util!"))).toBe("implement-a-stats-util")
    expect(specSlug("x".repeat(100)).length).toBeLessThanOrEqual(40)
    expect(String(specSlug("???"))).toBe("spec")
  })

  test("uniqueSlug suffixes on collision", () => {
    const taken = new Set(["stats", "stats-2"])
    expect(String(uniqueSlug(SpecSlug.make("stats"), (s) => taken.has(s)))).toBe("stats-3")
    expect(String(uniqueSlug(SpecSlug.make("free"), (s) => taken.has(s)))).toBe("free")
  })
})

describe("renderSpecSection", () => {
  test("carries goal, criteria, checks, constraints, and the gate framing", () => {
    const section = renderSpecSection(fullDoc)
    expect(section).toContain("# Spec (locked): stats-util")
    expect(section).toContain("mean handles the empty list")
    expect(section).toContain("stats-tests: `bun test src/stats.test.ts`")
    expect(section).toContain("do not touch existing exports")
    expect(section).toContain("no CLI surface")
    expect(section).toContain("gates say so")
  })

  test("omits empty sections", () => {
    const section = renderSpecSection(minimalDoc)
    expect(section).not.toContain("## Acceptance")
    expect(section).not.toContain("## Constraints")
  })
})
