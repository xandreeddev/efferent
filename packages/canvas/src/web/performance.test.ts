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

  test("all reference pages compile well inside the 20ms local budget", () => {
    const context = { pageId: "perf", csrfToken: "csrf", assets: new Map(), capabilities: new Set(["canvas.acknowledge", "canvas.request-demo"]) }
    ;[landingReference, applicationReference, architectureReference].forEach((reference) => {
      renderUiPage({ manifest: reference.page, blocks: reference.blocks, complete: true }, context)
    })
    const started = performance.now()
    ;[landingReference, applicationReference, architectureReference].forEach((reference) => {
      renderUiPage({ manifest: reference.page, blocks: reference.blocks, complete: true }, context)
    })
    expect(performance.now() - started).toBeLessThan(20)
  })
})
