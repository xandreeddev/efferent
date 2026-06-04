import { describe, expect, it } from "bun:test"
import {
  displayValue,
  openPrompt,
  promptAppend,
  promptBackspace,
  promptValue,
} from "./promptBox.js"

describe("promptBox", () => {
  it("appends and backspaces the raw value", () => {
    let s = openPrompt("Log in", "Paste your API key")
    s = promptAppend(s, "s")
    s = promptAppend(s, "k")
    expect(promptValue(s)).toBe("sk")
    s = promptBackspace(s)
    expect(promptValue(s)).toBe("s")
  })

  it("masks the displayed value but keeps the real one", () => {
    let s = openPrompt("Log in", "Paste your API key", true)
    for (const ch of "sk-abc") s = promptAppend(s, ch)
    expect(promptValue(s)).toBe("sk-abc")
    expect(displayValue(s)).toBe("••••••")
    expect(displayValue(s)).not.toContain("sk-abc")
  })

  it("shows the value verbatim when not masked", () => {
    let s = openPrompt("Paste", "redirect URL", false)
    for (const ch of "http://x") s = promptAppend(s, ch)
    expect(displayValue(s)).toBe("http://x")
  })
})
