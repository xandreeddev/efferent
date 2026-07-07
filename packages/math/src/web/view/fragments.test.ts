import { describe, expect, test } from "bun:test"
import { render } from "@xandreed/surface"
import type { MathShellView } from "./types.js"
import { renderMathShell } from "./shell.js"
import {
  renderMathFullSync,
  upsertMathControls,
  upsertMathHeader,
  upsertMathNote,
  upsertMathStage,
} from "./fragments.js"

const view: MathShellView = {
  title: "efferent math",
  wsUrl: "/ws?t=x",
  header: { grade: 4, theme: "fractions", solved: 1, generating: false },
  note: "note",
  stage: { kind: "skeleton", message: "writing…" },
  controls: { started: true, canNext: false, generating: true },
}

describe("math fragments", () => {
  test("every upsert stamps hx-swap-oob on its root (idempotent singleton swap)", () => {
    ;[
      render(upsertMathHeader(view.header)),
      render(upsertMathNote(view.note)),
      render(upsertMathStage(view.stage)),
      render(upsertMathControls(view.controls)),
    ].forEach((frag) => {
      expect(frag).toContain('hx-swap-oob="true"')
      // Stamped in the ROOT element (before the first '>').
      expect(frag.indexOf("hx-swap-oob")).toBeLessThan(frag.indexOf(">"))
    })
  })

  test("full sync carries all four singletons in one batch", () => {
    const sync = render(renderMathFullSync(view))
    ;["ef-m-header", "ef-m-note", "ef-m-card", "ef-m-controls"].forEach((id) => {
      expect(sync).toContain(`id="${id}"`)
    })
    expect(sync.match(/hx-swap-oob="true"/g)?.length).toBe(4)
  })

  test("full sync ≡ shell contents (same builders — the anti-drift seam)", () => {
    const page = renderMathShell(view)
    // Each synced singleton, minus its oob stamp, appears BYTE-IDENTICAL in the
    // initial document — same builders, so they cannot drift.
    ;[
      upsertMathHeader(view.header),
      upsertMathNote(view.note),
      upsertMathStage(view.stage),
      upsertMathControls(view.controls),
    ].forEach((frag) => {
      expect(page).toContain(render(frag).replace(' hx-swap-oob="true"', ""))
    })
  })
})
