import { describe, expect, test } from "bun:test"
import { renderMathShell } from "./mathShell.js"
import type { MathShellView } from "../mathViews.js"

const view: MathShellView = {
  title: "efferent math",
  wsUrl: "/ws?t=tok",
  header: { grade: 4, theme: "fractions", solved: 2, generating: false },
  note: "Nice streak!",
  stage: {
    kind: "exercise",
    exercise: {
      id: "ex-1",
      index: 1,
      total: 4,
      topic: "fractions",
      difficulty: "easy",
      prompt: "What is 1/4 + 2/4?",
      mathml: "<math><mfrac><mn>1</mn><mn>4</mn></mfrac></math>",
      input: { kind: "numeric" },
      done: false,
    },
  },
  controls: { started: true, canNext: true, generating: false },
}

const countOf = (s: string, needle: string): number => s.split(needle).length - 1

describe("math shell", () => {
  test("every math singleton id present exactly once, in document order", () => {
    const out = renderMathShell(view)
    ;["ef-app", "ef-m-header", "ef-m-note", "ef-m-card", "ef-m-controls", "ef-conn", "ef-resync"].forEach((id) => {
      expect(countOf(out, `id="${id}"`)).toBe(1)
    })
    const header = out.indexOf(`id="ef-m-header"`)
    const note = out.indexOf(`id="ef-m-note"`)
    const card = out.indexOf(`id="ef-m-card"`)
    const controls = out.indexOf(`id="ef-m-controls"`)
    expect(header).toBeLessThan(note)
    expect(note).toBeLessThan(card)
    expect(card).toBeLessThan(controls)
  })

  test("the design-system light theme is hard-stamped — no picker, no localStorage script", () => {
    const out = renderMathShell(view)
    expect(out).toContain(`<html lang="en" data-theme="math">`)
    expect(out).toContain(`<meta name="color-scheme" content="light" />`)
    expect(out).not.toContain("localStorage")
    expect(out).not.toContain("ef-theme-pick")
  })

  test("a PRODUCT shell: no chat composer, no drawers, no tabs, no hero, no send path", () => {
    const out = renderMathShell(view)
    ;["ef-composer", "ef-cmdbar", "ef-chat-drawer", "ef-refs-drawer", "ef-tabs", "ef-stage-empty", 'ws-send" '].forEach((absent) => {
      expect(out).not.toContain(absent)
    })
    // The resync form is the ONLY ws-send on the page.
    expect(countOf(out, "ws-send")).toBe(1)
  })

  test("loads ONLY tokens.css + math.css + htmx + ws ext + math.js — no Tailwind, no app.js, no kit, no mermaid", () => {
    const out = renderMathShell(view)
    expect(out).toMatch(/href="\/assets\/tokens\.css\?v=[a-z0-9]+"/)
    expect(out).toMatch(/href="\/assets\/math\.css\?v=[a-z0-9]+"/)
    expect(out).toMatch(/src="\/assets\/math\.js\?v=[a-z0-9]+"/)
    expect(out).toMatch(/src="\/assets\/htmx\.min\.js\?v=[a-z0-9]+"/)
    ;["tailwind.min.js", "app.js", "kit.css", "app.css", "diagrams.js", "mermaid"].forEach((absent) => {
      expect(out).not.toContain(absent)
    })
  })

  test("the app root owns the socket; the sanitized equation renders inline", () => {
    const out = renderMathShell(view)
    expect(out).toContain(`ws-connect="/ws?t=tok"`)
    expect(out).toContain("<math><mfrac><mn>1</mn><mn>4</mn></mfrac></math>")
  })
})
