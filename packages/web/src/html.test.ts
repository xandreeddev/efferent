import { describe, expect, test } from "bun:test"
import { empty, escapeHtml, html, join, raw, render } from "./html.js"

describe("html tagged template", () => {
  test("escapes interpolated strings", () => {
    expect(render(html`<p>${`<script>alert("x")</script>`}</p>`)).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>",
    )
  })

  test("escapes all five significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;")
  })

  test("passes Html through unescaped", () => {
    expect(render(html`<div>${raw("<b>bold</b>")}</div>`)).toBe("<div><b>bold</b></div>")
  })

  test("elides null, undefined and false", () => {
    const cond = false as boolean
    expect(render(html`<p>${null}${undefined}${cond && html`<b>never</b>`}</p>`)).toBe("<p></p>")
  })

  test("renders numbers", () => {
    expect(render(html`<i>${42}</i>`)).toBe("<i>42</i>")
  })

  test("flattens arrays recursively, escaping elements", () => {
    const items = ["a<b", raw("<i>x</i>"), ["nested", 7]]
    expect(render(html`<ul>${items}</ul>`)).toBe("<ul>a&lt;b<i>x</i>nested7</ul>")
  })

  test("nested templates compose without double-escaping", () => {
    const inner = html`<b>${"a&b"}</b>`
    expect(render(html`<p>${inner}</p>`)).toBe("<p><b>a&amp;b</b></p>")
  })

  test("join concatenates with an optional separator", () => {
    const parts = [html`<i>1</i>`, html`<i>2</i>`]
    expect(render(join(parts))).toBe("<i>1</i><i>2</i>")
    expect(render(join(parts, raw("\n")))).toBe("<i>1</i>\n<i>2</i>")
    expect(render(join([]))).toBe("")
    expect(render(empty)).toBe("")
  })

  test("a plain object with a non-string __html is escaped, not trusted", () => {
    const fake = { __html: 42 } as unknown as string
    expect(render(html`<p>${fake}</p>`)).not.toContain("<script")
  })
})
