import { describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { join } from "node:path"
import { architectureReference, applicationReference, landingReference } from "@xandreed/ui-agent"
import { renderUiPage } from "@xandreed/surface"
import { renderShell } from "./shell.js"

const ASSETS = join(import.meta.dir, "..", "..", "assets")

describe("the structured Canvas performance contract", () => {
  test("critical-path JavaScript stays below 120KB and has no Tailwind or Mermaid runtime", () => {
    const files = ["vendor/htmx.min.js", "vendor/htmx-ext-ws.js", "vendor/alpine.min.js", "app.js"]
    const bytes = files.reduce((total, file) => total + statSync(join(ASSETS, file)).size, 0)
    expect(bytes).toBeLessThanOrEqual(120_000)
    const shell = renderShell("csrf")
    expect(shell).not.toContain("tailwind")
    expect(shell).not.toContain("mermaid")
  })

  test("reference page batches compile inside the 20ms budget at p95 after warmup", () => {
    const context = { pageId: "perf", csrfToken: "csrf", assets: new Map(), capabilities: new Set(["canvas.acknowledge", "canvas.request-demo"]) }
    const compile = () => [landingReference, applicationReference, architectureReference].forEach((reference) => {
      renderUiPage({ manifest: reference.page, blocks: reference.blocks, complete: true }, context)
    })
    // Warm the renderer and Dagre before measuring steady-state compilation.
    // Keep the budget unchanged, and measure a distribution so one shared-runner
    // scheduling/GC pause does not decide the entire performance contract.
    Array.from({ length: 10 }).forEach(compile)
    const samples = Array.from({ length: 25 }, () => {
      const started = performance.now()
      compile()
      return performance.now() - started
    }).sort((left, right) => left - right)
    expect(samples[Math.ceil(samples.length * 0.95) - 1]).toBeLessThan(20)
  })
})
