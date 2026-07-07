import { describe, expect, test } from "bun:test"
import { render } from "./html.js"
import { renderMarkdown } from "./markdown.js"

const md = (src: string): string => render(renderMarkdown(src))

describe("renderMarkdown", () => {
  test("paragraphs and headings", () => {
    const out = md("# Title\n\nHello world.\n\n## Sub")
    expect(out).toContain(`<h1 class="ef-heading">Title</h1>`)
    expect(out).toContain("<p>Hello world.</p>")
    expect(out).toContain(`<h2 class="ef-heading">Sub</h2>`)
  })

  test("escapes HTML in prose", () => {
    expect(md("hello <script>alert(1)</script>")).not.toContain("<script>")
    expect(md("hello <script>x</script>")).toContain("&lt;script&gt;")
  })

  test("fenced code blocks keep content literal and record the language", () => {
    const out = md("```ts\nconst a = \"<b>\" && 1\n```")
    expect(out).toContain(`<pre class="ef-codeblock" data-lang="ts">`)
    expect(out).toContain("&lt;b&gt;")
    expect(out).toContain("&amp;&amp;")
    expect(out).not.toContain("<b>")
  })

  test("a ```mermaid fence stamps data-lang so diagrams.js can render it client-side", () => {
    const out = md("```mermaid\ngraph TD; A-->B\n```")
    expect(out).toContain(`<pre class="ef-codeblock" data-lang="mermaid">`)
    expect(out).toContain("graph TD; A--&gt;B")
  })

  test("inline code is literal, emphasis is not applied inside it", () => {
    const out = md("use `**not bold**` and **bold**")
    expect(out).toContain(`<code class="ef-code">**not bold**</code>`)
    expect(out).toContain("<strong>bold</strong>")
  })

  test("links: safe hrefs become anchors, unsafe schemes stay text", () => {
    const out = md("[ok](https://example.com) [bad](javascript:alert(1))")
    expect(out).toContain(`<a class="ef-link" href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>`)
    expect(out).not.toContain(`href="javascript:`)
  })

  test("lists, quotes, hr, tables", () => {
    const out = md("- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |")
    expect(out).toContain(`<ul class="ef-list"><li>one</li><li>two</li></ul>`)
    expect(out).toContain(`<ol class="ef-list"><li>first</li><li>second</li></ol>`)
    expect(out).toContain(`<blockquote class="ef-quote">quoted</blockquote>`)
    expect(out).toContain(`<hr class="ef-hr" />`)
    expect(out).toContain("<th>a</th>")
    expect(out).toContain("<td>2</td>")
    expect(out).not.toContain("---|")
  })

  test("unclosed fence swallows to EOF without crashing", () => {
    const out = md("```\ncode here")
    expect(out).toContain("code here")
  })
})
