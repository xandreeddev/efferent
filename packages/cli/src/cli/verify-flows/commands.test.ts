import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { openSelect } from "../presentation/selectBox.js"
import { makeApp } from "../view/appHarness.js"
import { fakeCtx, newStore } from "./harness.js"

/**
 * The `:` command flows + the model picker render — the in-TUI config surface a
 * user reaches for after onboarding (`:model`, `:login`, `:theme`). Keystrokes
 * route through the focused input → palette memo (same mechanism app.test.ts
 * proves for `:clear`); the picker render mirrors the `:model` overlay.
 */

test("typing :model surfaces the model command in the palette", async () => {
  const store = newStore()
  const { waitForFrame, mockInput, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 100,
    height: 26,
  })
  try {
    await mockInput.pressKeys([":", "m", "o", "d", "e", "l"])
    const frame = await waitForFrame((f) => f.includes(":model"))
    expect(frame).toContain(":model")
  } finally {
    renderer.destroy()
  }
})

test("typing :login surfaces the login command in the palette", async () => {
  const store = newStore()
  const { waitForFrame, mockInput, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 100,
    height: 26,
  })
  try {
    await mockInput.pressKeys([":", "l", "o", "g", "i", "n"])
    const frame = await waitForFrame((f) => f.includes(":login"))
    expect(frame).toContain(":login")
  } finally {
    renderer.destroy()
  }
})

test("the model picker renders the catalogue with the active row tagged", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 110,
    height: 28,
  })
  try {
    store.setOverlay({
      kind: "select",
      sel: openSelect("Select a model", [
        { value: { id: "flash" }, label: "opencode:deepseek-v4-flash", active: true },
        { value: { id: "pro" }, label: "opencode:deepseek-v4-pro" },
      ]),
      purpose: { tag: "model" },
    })
    const frame = await waitForFrame(
      (f) => f.includes("Select a model") && f.includes("deepseek-v4-flash"),
    )
    expect(frame).toContain("opencode:deepseek-v4-flash")
    expect(frame).toContain("opencode:deepseek-v4-pro")
    expect(frame).toContain("◀ active")
  } finally {
    renderer.destroy()
  }
})
