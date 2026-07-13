import { describe, expect, test } from "bun:test"
import { landingReference } from "@xandreed/ui-agent"
import { scoreInformationArchitecture, scoreRequestRelevance } from "./uiMatrix.js"

describe("the UI matrix deterministic scorers", () => {
  test("localized and inflected copy satisfies semantic concept aliases", () => {
    const page = {
      manifest: { ...landingReference.page, title: "Ricette Italiane" },
      blocks: landingReference.blocks.map((block) => block.kind === "hero" ? { ...block, title: "Ricette italiane per regione", lede: "Cerca ingredienti e ritrova le ricette salvate." } : block),
      complete: true,
    }
    expect(scoreRequestRelevance(page, [["italian", "italia"], ["recipe", "ricett"], ["regional", "region"], ["ingredient"], ["saved", "salvat"]])).toBe(1)
  })

  test("a structurally valid page still fails IA when it chooses the wrong archetype", () => {
    const page = { manifest: landingReference.page, blocks: landingReference.blocks, complete: true }
    expect(scoreInformationArchitecture(page, "landing")).toBe(1)
    expect(scoreInformationArchitecture(page, "application")).toBeLessThan(1)
  })
})
