import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  efficiencyConstraint,
  persistArtifact,
  RESEARCH_BUDGET_SLUG,
  type ConversationId,
} from "@xandreed/sdk-core"
import { LocalFileSystemLive } from "@xandreed/sdk-adapters"
import {
  discoverInstructionFiles,
  renderInstructionsSection,
} from "./discoverInstructionFiles.js"

/**
 * **The self-improving loop CLOSES** — proven end-to-end and deterministically
 * (no LLM, no flake): an over-research run's lesson is written by the efficiency
 * gate AND loaded into the NEXT run's system prompt. This is the compounding
 * half — "extract skills to improve and keep trying": run N's mistake becomes
 * run N+1's standing rule.
 *
 * It chains the REAL functions over a REAL temp workspace + the real FileSystem
 * adapter: efficiencyConstraint (the gate's verdict) → persistArtifact (the
 * Curator writes `.efferent/CONSTRAINTS.md`) → discoverInstructionFiles (the next
 * run discovers it) → renderInstructionsSection (it lands under `# Constraints`).
 * The behavioural half (the fleet then actually fetches less) is the model's job,
 * exercised by the live convergence run — not assertable without flake here.
 */
describe("self-improving loop closure — over-research lesson reaches the next run", () => {
  const cid = "conv-1" as unknown as ConversationId

  it("efficiency gate → persist → discover → renders under # Constraints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-closure-"))
    try {
      // (1) The gate's verdict on an over-worked run (12 workers > threshold).
      const candidate = efficiencyConstraint({ spawns: 12, tokens: 100_000 }, cid)
      expect(candidate).not.toBeNull()
      expect(candidate?.name).toBe(RESEARCH_BUDGET_SLUG)

      const rendered = await Effect.runPromise(
        Effect.gen(function* () {
          // (2) Curator persists it under the workspace's `.efferent/`.
          yield* persistArtifact(dir, candidate!)
          // (3) A FRESH next run discovers the instruction files…
          const files = yield* discoverInstructionFiles(dir, join(dir, "home"))
          // (4) …and renders them into the system prompt.
          return renderInstructionsSection(files)
        }).pipe(Effect.provide(LocalFileSystemLive)),
      )

      expect(rendered).toContain("# Constraints")
      expect(rendered).toContain("Right-size the fleet") // the research-budget rule, now standing
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a right-sized run writes NO constraint — nothing to inherit, no noise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-closure-"))
    try {
      expect(efficiencyConstraint({ spawns: 3, tokens: 150_000 }, cid)).toBeNull()
      const rendered = await Effect.runPromise(
        discoverInstructionFiles(dir, join(dir, "home")).pipe(
          Effect.map(renderInstructionsSection),
          Effect.provide(LocalFileSystemLive),
        ),
      )
      expect(rendered).not.toContain("Right-size the fleet")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
