import { describe, expect, test } from "bun:test"
import { parseInline, parseMarkdown } from "./markdown.ts"

describe("markdown reader for the chat", () => {
  test("paragraphs, soft breaks and emphasis", () => {
    expect(parseMarkdown("Hello **world** and *you*.\nNext line")).toEqual([
      { t: "p", c: [
        { t: "text", v: "Hello " }, { t: "strong", c: [{ t: "text", v: "world" }] }, { t: "text", v: " and " },
        { t: "em", c: [{ t: "text", v: "you" }] }, { t: "text", v: "." }, { t: "br" }, { t: "text", v: "Next line" },
      ] },
    ])
  })

  test("a fenced block keeps its text verbatim, and an unfinished one shows what has streamed", () => {
    expect(parseMarkdown("Try:\n```ts\nconst a = *1*\n```\nDone")).toEqual([
      { t: "p", c: [{ t: "text", v: "Try:" }] },
      { t: "code", lang: "ts", v: "const a = *1*" },
      { t: "p", c: [{ t: "text", v: "Done" }] },
    ])
    expect(parseMarkdown("```\nhalf")).toEqual([{ t: "code", lang: "", v: "half" }])
  })

  test("lists, headings, quotes and rules", () => {
    expect(parseMarkdown("# Title\n- one\n- two\n\n1. a\n2. b\n\n> quoted\n\n---")).toEqual([
      { t: "h", level: 1, c: [{ t: "text", v: "Title" }] },
      { t: "list", ordered: false, items: [[{ t: "text", v: "one" }], [{ t: "text", v: "two" }]] },
      { t: "list", ordered: true, items: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]] },
      { t: "quote", c: [{ t: "p", c: [{ t: "text", v: "quoted" }] }] },
      { t: "hr" },
    ])
  })

  test("inline code is literal; snake_case and an unterminated marker are left alone", () => {
    expect(parseInline("use `a*b*` here")).toEqual([{ t: "text", v: "use " }, { t: "code", v: "a*b*" }, { t: "text", v: " here" }])
    expect(parseInline("my_var_name and **open")).toEqual([{ t: "text", v: "my_var_name and **open" }])
  })

  test("only http(s) links become links; HTML in the text stays text", () => {
    expect(parseInline("[docs](https://example.com/a) [bad](javascript:alert(1))")).toEqual([
      { t: "link", href: "https://example.com/a", c: [{ t: "text", v: "docs" }] },
      { t: "text", v: " [bad](javascript:alert(1))" },
    ])
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ t: "text", v: "<img src=x onerror=alert(1)>" }])
  })
})
