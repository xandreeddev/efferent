import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import { SmokeApp } from "./smokeApp.js"

/**
 * Groundwork smoke test: proves the whole stack boots end-to-end —
 *   1. the Bun preload transforms the imported `.tsx` via babel-preset-solid,
 *   2. the @opentui/solid reconciler maps JSX → native renderables,
 *   3. @opentui/core's native Zig lib loads via FFI and lays out + draws,
 *   4. the headless test renderer captures the frame as text.
 * The JSX lives in an imported module (smokeApp.tsx), not this entrypoint —
 * Bun's runtime plugin intercepts imported `.tsx`, which mirrors the real app
 * (every tui-solid component is imported, never an entrypoint). Uses the
 * memory-buffer test renderer, so it needs no TTY.
 */
test("OpenTUI + Solid render a bordered box with text", async () => {
  const { waitForFrame, renderer } = await testRender(SmokeApp, {
    width: 40,
    height: 8,
  })
  try {
    const frame = await waitForFrame((f) => f.includes("hello opentui"))
    expect(frame).toContain("hello opentui")
    expect(frame).toContain("smoke") // border title rendered
  } finally {
    renderer.destroy()
  }
})
