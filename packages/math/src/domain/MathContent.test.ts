import { describe, expect, test } from "bun:test"
import { FastCheck } from "effect"
import { gradeAnswer, parseMathItems } from "./MathContent.js"
import type { MathAnswer, MathExercise } from "./MathContent.js"

const exercise = (over: Partial<MathExercise> & { answer?: Partial<MathAnswer> } = {}): unknown => ({
  kind: "exercise",
  id: "ex-1",
  prompt: "What is 1/4 + 2/4?",
  answer: { kind: "fraction", value: "3/4", ...over.answer },
  hint: "Add the numerators — the denominators already match.",
  solution: [{ text: "1/4 + 2/4 = (1+2)/4 = 3/4" }],
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "answer")),
})

describe("parseMathItems", () => {
  test("accepts a valid batch and preserves order", () => {
    const out = parseMathItems([
      exercise(),
      { kind: "note", text: "Nice streak — these get a little harder." },
      exercise({ id: "ex-2", answer: { kind: "integer", value: "28" } }),
    ])
    expect(out.rejected).toEqual([])
    expect(out.accepted.map((i) => (i.kind === "exercise" ? i.id : "note"))).toEqual([
      "ex-1",
      "note",
      "ex-2",
    ])
  })

  test("one bad item never loses the batch", () => {
    const out = parseMathItems([
      exercise(),
      { kind: "exercise", id: "ex-2" }, // structurally broken
      exercise({ id: "ex-3" }),
    ])
    expect(out.accepted).toHaveLength(2)
    expect(out.rejected).toHaveLength(1)
    expect(out.rejected[0]?.index).toBe(1)
    expect(out.rejected[0]?.id).toBe("ex-2")
  })

  test("semantic rejections: choice key must reference an option", () => {
    const out = parseMathItems([
      exercise({
        id: "ex-9",
        choices: [
          { id: "a", label: "1/2" },
          { id: "b", label: "3/4" },
        ],
        answer: { kind: "choice", value: "c" },
      }),
    ])
    expect(out.accepted).toEqual([])
    expect(out.rejected[0]?.reason).toContain("not one of the choice ids")
  })

  test("semantic rejections: numeric keys must parse; ids unique; placeholder prompts", () => {
    const out = parseMathItems([
      exercise({ answer: { kind: "integer", value: "three" } }),
      exercise({ id: "ex-1", answer: { kind: "decimal", value: "0.5" } }),
      exercise({ id: "ex-1", answer: { kind: "decimal", value: "0.5" } }),
      exercise({ id: "ex-4", prompt: "What is ?/? of the circle?" }),
      { kind: "note", text: "one" },
      { kind: "note", text: "two" },
    ])
    expect(out.accepted).toHaveLength(2) // the first ex-1 decimal + the first note
    expect(out.rejected.map((r) => r.reason)).toEqual([
      expect.stringContaining("not an integer"),
      expect.stringContaining("duplicate exercise id"),
      expect.stringContaining("placeholder"),
      expect.stringContaining("only one note"),
    ])
  })

  test("a prompt that needs a picture is rejected — there is no picture (live-caught failure)", () => {
    const out = parseMathItems([
      exercise({ id: "ex-7", prompt: "What fraction of the rectangle is shaded?" }),
      exercise({ id: "ex-8", prompt: "Look at the diagram and count the parts." }),
      exercise({ id: "ex-9", prompt: "Using the figure shown below, find the area." }),
      exercise({ id: "ex-10", prompt: "A rectangle is 3 cm by 4 cm. What is its area in cm²?" }),
    ])
    expect(out.accepted.map((i) => (i.kind === "exercise" ? i.id : ""))).toEqual(["ex-10"])
    out.rejected.forEach((r) => expect(r.reason).toContain("cannot be shown"))
  })

  test("non-array input yields empty, not a crash", () => {
    expect(parseMathItems(undefined)).toEqual({ accepted: [], rejected: [] })
    expect(parseMathItems({ items: [] })).toEqual({ accepted: [], rejected: [] })
  })
})

describe("gradeAnswer", () => {
  const key = (kind: MathAnswer["kind"], value: string, extra: Partial<MathAnswer> = {}): MathAnswer =>
    ({ kind, value, ...extra }) as MathAnswer

  test("integer: spacing, sign, integral decimals", () => {
    expect(gradeAnswer(key("integer", "28"), " 28 ").correct).toBe(true)
    expect(gradeAnswer(key("integer", "28"), "28.0").correct).toBe(true)
    expect(gradeAnswer(key("integer", "-4"), "-4").correct).toBe(true)
    expect(gradeAnswer(key("integer", "28"), "27").correct).toBe(false)
    expect(gradeAnswer(key("integer", "28"), "28.5").correct).toBe(false)
    expect(gradeAnswer(key("integer", "28"), "twenty-eight").correct).toBe(false)
  })

  test("decimal: tolerance and comma input", () => {
    expect(gradeAnswer(key("decimal", "3.5"), "3,5").correct).toBe(true)
    expect(gradeAnswer(key("decimal", "3.14", { tolerance: 0.01 }), "3.15").correct).toBe(true)
    expect(gradeAnswer(key("decimal", "3.14", { tolerance: 0.01 }), "3.2").correct).toBe(false)
    expect(gradeAnswer(key("decimal", "0.1"), "0.1").correct).toBe(true)
  })

  test("fraction: equivalence, mixed numbers, decimals", () => {
    expect(gradeAnswer(key("fraction", "3/4"), "6/8").correct).toBe(true)
    expect(gradeAnswer(key("fraction", "3/4"), "0.75").correct).toBe(true)
    expect(gradeAnswer(key("fraction", "3/2"), "1 1/2").correct).toBe(true)
    expect(gradeAnswer(key("fraction", "-1/2"), "-2/4").correct).toBe(true)
    expect(gradeAnswer(key("fraction", "3/4"), "2/4").correct).toBe(false)
    expect(gradeAnswer(key("fraction", "3/4"), "3/0").correct).toBe(false)
    expect(gradeAnswer(key("fraction", "3/4"), "").correct).toBe(false)
  })

  test("text: case/whitespace/trailing-dot normalization + accept list", () => {
    expect(gradeAnswer(key("text", "Isosceles"), "  isosceles. ").correct).toBe(true)
    expect(
      gradeAnswer(key("text", "three quarters", { accept: ["3/4", "0.75"] }), "3/4").correct,
    ).toBe(true)
    expect(gradeAnswer(key("text", "isosceles"), "scalene").correct).toBe(false)
  })

  test("choice: id match, case-insensitive", () => {
    expect(gradeAnswer(key("choice", "b"), "b").correct).toBe(true)
    expect(gradeAnswer(key("choice", "b"), " B ").correct).toBe(true)
    expect(gradeAnswer(key("choice", "b"), "a").correct).toBe(false)
  })

  test("normalized echoes the parsed canonical form", () => {
    expect(gradeAnswer(key("decimal", "3.5"), "3,5").normalized).toBe("3.5")
    expect(gradeAnswer(key("fraction", "3/4"), " 6 / 8 ").normalized).toBe("6/8")
    expect(gradeAnswer(key("integer", "28"), "nope").normalized).toBe("nope")
  })

  test("property: every well-formed key grades its own value correct", () => {
    const intKey = FastCheck.integer({ min: -10_000, max: 10_000 }).map((n) =>
      key("integer", String(n)),
    )
    const decKey = FastCheck.tuple(
      FastCheck.integer({ min: -9999, max: 9999 }),
      FastCheck.integer({ min: 0, max: 3 }),
    ).map(([n, places]) => key("decimal", (n / 10 ** places).toFixed(places)))
    const fracKey = FastCheck.tuple(
      FastCheck.integer({ min: -99, max: 99 }),
      FastCheck.integer({ min: 1, max: 99 }),
    ).map(([n, d]) => key("fraction", `${n}/${d}`))
    const textKey = FastCheck.stringMatching(/^[a-z][a-z ]{0,20}[a-z]$/).map((s) =>
      key("text", s),
    )
    const choiceKey = FastCheck.constantFrom("a", "b", "c", "d").map((c) => key("choice", c))
    const anyKey = FastCheck.oneof(intKey, decKey, fracKey, textKey, choiceKey)
    FastCheck.assert(
      FastCheck.property(anyKey, (k) => gradeAnswer(k, k.value).correct),
      { numRuns: 300 },
    )
  })
})

describe("parseMathItems — session dedupe", () => {
  test("an id already served this session bounces with a fix-it reason", () => {
    const out = parseMathItems([exercise(), exercise({ id: "ex-9" })], new Set(["ex-1"]))
    expect(out.accepted.filter((i) => i.kind !== "note").map((i) => (i as { id: string }).id)).toEqual(["ex-9"])
    expect(out.rejected).toHaveLength(1)
    expect(out.rejected[0]?.reason).toContain("already served this session")
    expect(out.rejected[0]?.reason).toContain("ex-1")
  })

  test("in-call duplicate still wins over session dedupe (distinct reasons)", () => {
    const out = parseMathItems([exercise({ id: "ex-2" }), exercise({ id: "ex-2" })], new Set())
    expect(out.accepted).toHaveLength(1)
    expect(out.rejected[0]?.reason).toContain("in this call")
  })
})

describe("parseMathItems — strict MathML admission", () => {
  const good = "<math><mfrac><mn>1</mn><mn>4</mn></mfrac></math>"

  test("valid presentation MathML is admitted, on the exercise and its parts", () => {
    const out = parseMathItems([
      exercise({
        mathml: good,
        answer: { kind: "choice", value: "a" },
        choices: [
          { id: "a", label: "3/4", mathml: good },
          { id: "b", label: "1/2" },
        ],
        solution: [{ text: "step", mathml: good }],
      }),
    ])
    expect(out.rejected).toEqual([])
    expect(out.accepted).toHaveLength(1)
  })

  test("rejected MathML bounces at admission and names the offending part", () => {
    const bad = "<math><semantics><annotation-xml></annotation-xml></semantics></math>"
    const onEx = parseMathItems([exercise({ mathml: bad })])
    expect(onEx.accepted).toEqual([])
    expect(onEx.rejected[0]?.reason).toContain("the exercise mathml was rejected")

    const onChoice = parseMathItems([
      exercise({
        answer: { kind: "choice", value: "a" },
        choices: [
          { id: "a", label: "x", mathml: bad },
          { id: "b", label: "y" },
        ],
      }),
    ])
    expect(onChoice.rejected[0]?.reason).toContain("choice 'a' mathml was rejected")

    const onStep = parseMathItems([exercise({ solution: [{ text: "s", mathml: bad }] })])
    expect(onStep.rejected[0]?.reason).toContain("solution step 1 mathml was rejected")
  })

  test("non-math markup smuggled as mathml is rejected", () => {
    const out = parseMathItems([exercise({ mathml: "<div onclick=alert(1)>hi</div>" })])
    expect(out.accepted).toEqual([])
    expect(out.rejected[0]?.reason).toContain("strict sanitizer")
  })
})
