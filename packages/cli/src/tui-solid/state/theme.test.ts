import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ConversationId } from "@efferent/core"
import { themes } from "../presentation/theme/index.js"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { openThemePicker } from "../actions/theme.js"
import { createTuiStore, type TuiStore } from "./store.js"
import { activeThemeName, paneBorder, setTheme, themeNames, tokens } from "./theme.js"

// The active theme is a process-global signal — reset it so tests don't leak.
afterEach(() => setTheme("one-dark"))

const cid = "00000000-0000-0000-0000-000000000000" as unknown as ConversationId
const newStore = (): TuiStore =>
  createTuiStore({
    status: { modelId: "m", cwd: "/work", storage: "sqlite" },
    conversationId: cid,
    footer: "f",
    sidePane: { ...emptySidePane, stats: { ...emptyStats, contextWindow: 1000 } },
  })

const HEX = /^#[0-9a-f]{6}$/i

describe("theme registry", () => {
  test("ships efferent (the default), one-dark, and tokyo-night, each with a complete token set", () => {
    expect(themeNames()).toEqual(["efferent", "one-dark", "tokyo-night"])
    for (const name of themeNames()) {
      const t = themes[name]!.tokens
      // representative leaves across the token groups — all real hex values
      for (const hex of [
        t.accent.conversation,
        t.accent.side,
        t.accent.input,
        t.text.default,
        t.state.error,
        t.match.current,
        t.overlay.border,
        t.cursorLine,
        t.info,
        t.syntax.keyword,
        t.syntax.string,
        t.syntax.comment,
      ]) {
        expect(hex).toMatch(HEX)
      }
    }
  })
})

describe("setTheme / reactive tokens", () => {
  test("switching the theme swaps the values the proxy returns", () => {
    setTheme("one-dark")
    const darkAccent = tokens.accent.conversation
    const darkKeyword = tokens.syntax.keyword

    expect(setTheme("tokyo-night")).toBe(true)
    expect(activeThemeName()).toBe("tokyo-night")
    // the proxy now reads the tokyo-night theme
    expect(tokens.accent.conversation).toBe("#7aa2f7")
    expect(tokens.syntax.keyword).toBe("#bb9af7")
    expect(tokens.accent.conversation).not.toBe(darkAccent)
    expect(tokens.syntax.keyword).not.toBe(darkKeyword)
    // paneBorder is reactive too (reads the proxy)
    expect(paneBorder("conversation", true)).toBe("#7aa2f7")
    expect(paneBorder("conversation", false)).toBe(themes["tokyo-night"]!.tokens.border.unfocused)
  })

  test("an unknown theme name is a no-op returning false", () => {
    setTheme("tokyo-night")
    expect(setTheme("does-not-exist")).toBe(false)
    expect(activeThemeName()).toBe("tokyo-night") // unchanged
  })
})

describe("openThemePicker", () => {
  test("builds a select overlay listing every theme, the active one tagged", () => {
    setTheme("tokyo-night")
    const store = newStore()
    Effect.runSync(openThemePicker(store))

    const o = store.overlay()
    expect(o.kind).toBe("select")
    if (o.kind !== "select") throw new Error("expected a select overlay")
    expect(o.purpose).toEqual({ tag: "theme" })
    expect(o.sel.all.map((opt) => opt.label)).toEqual(["efferent", "one-dark", "tokyo-night"])
    // the active theme is pre-highlighted
    const active = o.sel.all.find((opt) => opt.active === true)
    expect(active?.value).toBe("tokyo-night")
  })
})
