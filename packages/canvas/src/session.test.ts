import { describe, expect, test } from "bun:test"
import { looksLikeHtmlDump } from "./session.js"

describe("looksLikeHtmlDump — chat text is a caption channel", () => {
  test("plain captions pass", () => {
    expect(looksLikeHtmlDump("Built the pomodoro page — hit start.")).toBe(false)
    expect(looksLikeHtmlDump("I used <strong> emphasis on the totals row.")).toBe(false)
    expect(looksLikeHtmlDump("")).toBe(false)
  })

  test("a fenced html block is a dump", () => {
    expect(looksLikeHtmlDump("Here is the code:\n```html\n<div>x</div>\n```")).toBe(true)
  })

  test("dense inline markup is a dump", () => {
    expect(
      looksLikeHtmlDump(
        `If you want it interactive: <div x-data="{on:false}"><button @click="on=!on">go</button><span x-show="on">hi</span><p>done</p></div>`,
      ),
    ).toBe(true)
  })
})
