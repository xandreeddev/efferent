import { describe, expect, test } from "bun:test"
import { assetHref, staticAssets } from "./static.js"

describe("static assets", () => {
  test("manifest carries every served asset with a content hash", () => {
    const names = staticAssets.map((a) => a.path)
    for (const n of [
      "/assets/htmx.min.js",
      "/assets/htmx-ext-ws.js",
      "/assets/mermaid.min.js",
      "/assets/app.js",
      "/assets/diagrams.js",
      "/assets/app.css",
      "/assets/kit.css",
      "/assets/tokens.css",
    ]) {
      expect(names).toContain(n)
    }
    for (const a of staticAssets) expect(a.hash.length).toBeGreaterThan(0)
  })

  test("assetHref returns the versioned path for known assets", () => {
    expect(assetHref("kit.css")).toMatch(/^\/assets\/kit\.css\?v=[a-z0-9]+$/)
  })

  test("no hex colour literal outside tokens.css (chrome + kit paint var(--tok-*) only)", () => {
    for (const name of ["app.css", "kit.css"]) {
      const css = staticAssets.find((a) => a.path.endsWith(`/${name}`))?.content ?? ""
      expect(css.length).toBeGreaterThan(0)
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    }
  })
})
