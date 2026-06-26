import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import {
  onboardingToComplete,
  onboardingToTheme,
  startOnboarding,
} from "../presentation/onboardingFlow.js"
import { makeApp } from "../view/appHarness.js"
import { fakeCtx, newStore } from "./harness.js"

/**
 * The onboarding flow renders across its steps — the first-run experience the
 * daemon path and `efferent code` both gate behind an empty AuthStore. Driven by
 * advancing the PURE onboarding state machine and asserting the App renders each
 * step full-screen (deterministic — no Effect handlers, no LLM, no terminal).
 */

test("onboarding renders the scope step (step 1 of the first-run flow)", async () => {
  const store = newStore()
  store.setOverlay({ kind: "onboarding", state: startOnboarding([]) })
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 100,
    height: 30,
  })
  try {
    const frame = await waitForFrame((f) => f.includes("Step 1 of 7"))
    expect(frame).toContain("Step 1 of 7")
    expect(frame).toContain("global") // the machine-wide scope option
    expect(frame).toContain("local") // the just-this-folder option
  } finally {
    renderer.destroy()
  }
})

test("onboarding advances to the theme step", async () => {
  const store = newStore()
  store.setOverlay({ kind: "onboarding", state: onboardingToTheme(startOnboarding([]), "efferent") })
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 100,
    height: 30,
  })
  try {
    const frame = await waitForFrame((f) => f.toLowerCase().includes("theme"))
    expect(frame.toLowerCase()).toContain("theme")
  } finally {
    renderer.destroy()
  }
})

test("onboarding reaches the complete step", async () => {
  const store = newStore()
  store.setOverlay({ kind: "onboarding", state: onboardingToComplete(startOnboarding([])) })
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 100,
    height: 30,
  })
  try {
    // The complete step renders (the overlay is still the onboarding takeover);
    // we assert the App didn't crash mapping the terminal state to a frame.
    const frame = await waitForFrame((f) => f.length > 0)
    expect(frame.length).toBeGreaterThan(0)
  } finally {
    renderer.destroy()
  }
})
