import { describe, expect, test } from "bun:test"
import { renderUiFindings, validateUi } from "./validate.js"

const rules = (html: string): ReadonlyArray<string> => validateUi(html).map((f) => f.rule)

describe("validateUi — the ui-builder's hard gates", () => {
  test("a clean kit page passes", () => {
    const page = `
      <section class="ef-hero"><h1>Pricing</h1><p>Three plans.</p></section>
      <div class="ef-cols">
        <div class="ef-card"><h2>Free</h2><p>$0</p></div>
        <div class="ef-card"><h2>Pro</h2><p>$19</p></div>
      </div>
      <form hx-post="/action/ui" hx-swap="none">
        <input type="hidden" name="ui-id" value="pricing" />
        <label for="plan">Pick a plan</label>
        <select id="plan" name="plan"><option value="free">Free</option></select>
        <button type="submit">Choose</button>
      </form>`
    expect(validateUi(page)).toEqual([])
  })

  test("dangerous vocabulary: script/iframe/svg/on*/style all surface as findings", () => {
    const attack = `
      <div onclick="steal()">x</div>
      <script>alert(1)</script>
      <iframe src="https://evil.example"></iframe>
      <svg><circle r="4" /></svg>
      <p style="background:url(https://evil.example/p.png)">hi</p>`
    const found = validateUi(attack)
    const details = renderUiFindings(found)
    expect(found.every((f) => f.rule === "dangerous-vocabulary")).toBe(true)
    expect(details).toContain("script")
    expect(details).toContain("iframe")
    expect(details).toContain("svg")
    expect(details).toContain("onclick")
    expect(details).toContain("style")
  })

  test("hx-wiring: off-/action/ posts, dangling hx-target, missing ui-id", () => {
    expect(rules(`<button hx-post="https://evil.example/x">Go</button>`)).toContain("hx-wiring")
    expect(rules(`<button hx-post="/action/ui" hx-target="#nope">Go</button><input name="ui-id" value="p" />`)).toContain("hx-wiring")
    expect(
      rules(`<div id="out"><button hx-post="/action/ui" hx-target="#out">Go</button></div><input name="ui-id" value="p" />`),
    ).not.toContain("hx-wiring")
    expect(rules(`<form hx-post="/action/ui"><button>Send</button></form>`)).toContain("hx-wiring")
  })

  test("a11y minimum: unlabelled img/button/input; labelled variants pass", () => {
    expect(rules(`<img src="/assets/x.png" />`)).toContain("a11y-min")
    expect(rules(`<img src="/assets/x.png" alt="chart of costs" />`)).not.toContain("a11y-min")
    expect(rules(`<button></button>`)).toContain("a11y-min")
    expect(rules(`<button aria-label="close"></button>`)).not.toContain("a11y-min")
    expect(rules(`<input type="text" name="email" />`)).toContain("a11y-min")
    expect(rules(`<label for="e">Email</label><input id="e" type="text" name="email" />`)).not.toContain("a11y-min")
    expect(rules(`<input type="hidden" name="ui-id" value="x" />`)).not.toContain("a11y-min")
  })

  test("no-arbitrary-values: bg-[url(…)] (exfiltration) and w-[…] are banned; named utilities pass", () => {
    expect(rules(`<div class="bg-[url(https://evil.example/x.png)]">x</div>`)).toContain("no-arbitrary-values")
    expect(rules(`<div class="w-[437px] text-[13px]">x</div>`)).toContain("no-arbitrary-values")
    expect(rules(`<div class="grid grid-cols-3 gap-4 bg-slate-900 text-sm">x</div>`)).not.toContain("no-arbitrary-values")
  })

  test("no-self-trigger: load/every/revealed fire without user action and are banned; click passes", () => {
    expect(rules(`<div hx-get="/action/ui" hx-trigger="load delay:1s"></div><input name="ui-id" value="p" />`)).toContain("no-self-trigger")
    expect(rules(`<div hx-post="/action/ui" hx-trigger="every 2s"></div><input name="ui-id" value="p" />`)).toContain("no-self-trigger")
    expect(rules(`<div hx-get="/action/ui" hx-trigger="revealed"></div><input name="ui-id" value="p" />`)).toContain("no-self-trigger")
    expect(
      rules(`<button hx-post="/action/ui" hx-trigger="click">Go</button><input name="ui-id" value="p" />`),
    ).not.toContain("no-self-trigger")
    // The htmx data- alias obeys the same rule.
    expect(rules(`<div hx-get="/action/ui" data-hx-trigger="load"></div><input name="ui-id" value="p" />`)).toContain("no-self-trigger")
  })

  test("findings accumulate across families and render deterministically", () => {
    const bad = `
      <script>x</script>
      <img src="/x.png" />
      <button hx-post="/evil">Go</button>
      <div class="p-[3px]">x</div>`
    const found = validateUi(bad)
    expect(new Set(found.map((f) => f.rule))).toEqual(
      new Set(["dangerous-vocabulary", "a11y-min", "hx-wiring", "no-arbitrary-values"]),
    )
    expect(renderUiFindings(found)).toBe(renderUiFindings([...found].reverse()))
  })
})
