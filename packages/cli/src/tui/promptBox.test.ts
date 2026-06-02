import { describe, expect, it } from "bun:test"
import {
  displayValue,
  openPrompt,
  promptAppend,
  promptBackspace,
  promptValue,
  renderPromptBox,
} from "./promptBox.js"

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

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

  it("renders the title + prompt + masked value, never the secret", () => {
    let s = openPrompt("Log in to Anthropic", "Paste your API key", true)
    for (const ch of "sk-secret") s = promptAppend(s, ch)
    const blob = renderPromptBox(s, 30, 80)
      .map((o) => stripAnsi(o.content))
      .join("\n")
    expect(blob).toContain("Log in to Anthropic")
    expect(blob).toContain("Paste your API key")
    expect(blob).toContain("submit")
    expect(blob).not.toContain("sk-secret")
    expect(blob).toContain("•")
  })
})
