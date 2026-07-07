import { describe, expect, test } from "bun:test"
import { render } from "../../html.js"
import { staticAssets } from "../../assets/static.js"
import type { MathExerciseView } from "../../mathViews.js"
import { renderMathControls } from "./controls.js"
import { renderExerciseCard } from "./exerciseCard.js"
import { renderMathNote } from "./note.js"
import { renderSetupForm } from "./setupForm.js"
import { renderMathError, renderSkeleton } from "./skeleton.js"
import { renderMathStage } from "./stage.js"
import { renderMathTopbar } from "./topbar.js"

const exercise: MathExerciseView = {
  id: "ex-3",
  index: 3,
  total: 5,
  topic: "fractions",
  difficulty: "medium",
  prompt: "What is 1/4 + 2/4?",
  mathml: "<math><mfrac><mn>1</mn><mn>4</mn></mfrac><mo>+</mo><mfrac><mn>2</mn><mn>4</mn></mfrac></math>",
  input: { kind: "numeric", placeholder: "e.g. 3/4" },
  feedback: {
    verdict: "wrong",
    echo: "2/6",
    hint: "The denominators already match — add the numerators.",
  },
  done: false,
}

const { feedback: _fb, ...exerciseNoFeedback } = exercise

const choiceExercise: MathExerciseView = {
  ...exerciseNoFeedback,
  id: "ex-4",
  input: {
    kind: "choice",
    choices: [
      { id: "a", label: "1/2" },
      { id: "b", label: "3/4", mathml: "<math><mfrac><mn>3</mn><mn>4</mn></mfrac></math>" },
    ],
  },
}

/** Every rendered surface — the cross-check corpus. */
const renderedAll = (): string =>
  [
    render(renderMathTopbar({ grade: 4, theme: "fractions", solved: 3, generating: true })),
    render(renderMathNote("Nice streak — these get harder.")),
    render(renderMathNote(undefined)),
    render(renderMathControls({ started: true, canNext: true, generating: true })),
    render(renderMathControls({ started: false, canNext: false, generating: false })),
    render(renderExerciseCard(exercise)),
    render(renderExerciseCard(choiceExercise)),
    render(
      renderExerciseCard({
        ...exercise,
        id: "ex-5",
        done: true,
        feedback: {
          verdict: "correct",
          echo: "3/4",
          correctAnswer: "3/4",
          solution: [{ text: "Add the numerators: 1 + 2 = 3.", mathml: "<math><mn>3</mn></math>" }],
        },
      }),
    ),
    render(
      renderExerciseCard({
        ...exercise,
        id: "ex-6",
        done: true,
        feedback: {
          verdict: "revealed",
          correctAnswer: "3/4",
          solution: [{ text: "1/4 + 2/4 = 3/4" }],
        },
      }),
    ),
    render(renderSetupForm({ grade: 4, theme: "", suggestions: ["fractions", "decimals"] })),
    render(renderSkeleton("writing your exercises…")),
    render(renderMathError("The tutor hit a snag.", "provider timeout")),
    render(renderMathStage({ kind: "skeleton", message: "…" })),
  ].join("\n")

describe("math components ↔ math.css", () => {
  test("every ef-m-* class a component emits exists in math.css (the design-system contract)", () => {
    const css = staticAssets.find((a) => a.path.endsWith("/math.css"))?.content ?? ""
    expect(css.length).toBeGreaterThan(0)
    const out = renderedAll()
    const used = new Set(
      [...out.matchAll(/class="([^"]*)"/g)]
        .flatMap((m) => (m[1] ?? "").split(/\s+/))
        .filter((cls) => cls.startsWith("ef-m-")),
    )
    expect(used.size).toBeGreaterThan(15)
    used.forEach((cls) => {
      expect(css).toContain(`.${cls}`)
    })
  })

  test("interactivity is typed actions only — every form posts under /action/, nothing else", () => {
    const out = renderedAll()
    const posts = [...out.matchAll(/hx-post="([^"]*)"/g)].map((m) => m[1] ?? "")
    expect(posts.length).toBeGreaterThan(5)
    posts.forEach((p) => expect(p.startsWith("/action/")).toBe(true))
    expect(out).not.toContain("ws-send")
    expect(out).not.toContain('name="prompt"')
  })

  test("the check form carries the exercise id + value field; choices are radios", () => {
    const numeric = render(renderExerciseCard(exercise))
    expect(numeric).toContain('hx-post="/action/check"')
    expect(numeric).toContain('name="ex" value="ex-3"')
    expect(numeric).toContain('name="value"')
    expect(numeric).toContain('value="2/6"') // retry keeps the last answer
    expect(numeric).toContain("Try again")
    const choice = render(renderExerciseCard(choiceExercise))
    expect(choice).toContain('type="radio"')
    expect(choice).toContain("<math><mfrac><mn>3</mn><mn>4</mn></mfrac></math>") // MathML choice label
  })

  test("a done exercise freezes: no answer form, no reveal — report stays", () => {
    const done = render(
      renderExerciseCard({
        ...exercise,
        done: true,
        feedback: { verdict: "correct", echo: "3/4" },
      }),
    )
    expect(done).not.toContain('hx-post="/action/check"')
    expect(done).not.toContain('hx-post="/action/reveal"')
    expect(done).toContain('hx-post="/action/report"')
  })

  test("a hostile mathml snippet is dropped, never rendered (prompt text carries the question)", () => {
    const out = render(
      renderExerciseCard({
        ...exerciseNoFeedback,
        mathml: `<math><mi>x</mi><script>alert(1)</script></math>`,
      }),
    )
    expect(out).not.toContain("script")
    expect(out).not.toContain("ef-m-equation") // the whole block is omitted
    expect(out).toContain("What is 1/4 + 2/4?")
  })

  test("setup: chips are one-tap submits carrying their topic; free text rides theme-custom", () => {
    const out = render(renderSetupForm({ grade: 5, theme: "", suggestions: ["fractions"] }))
    expect(out).toContain('hx-post="/action/topic"')
    expect(out).toContain('name="theme" value="fractions"')
    expect(out).toContain('name="theme-custom"')
    expect(out).toContain('<option value="5" selected>')
  })

  test("controls: agent actions freeze while generating, Next follows canNext", () => {
    const busy = render(renderMathControls({ started: true, canNext: false, generating: true }))
    expect(busy.match(/disabled/g)?.length).toBe(4) // next (no queue) + more/harder/easier
    expect(busy).toContain("/action/interrupt")
    const idle = render(renderMathControls({ started: true, canNext: true, generating: false }))
    expect(idle).not.toContain("disabled")
  })
})
