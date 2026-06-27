import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import type { Candidate, CandidateKind } from "../entities/Distillation.js"
import {
  type FileReadResult,
  FileNotFound,
  FileSystem,
} from "../ports/FileSystem.js"
import { persistArtifact } from "./persistArtifact.js"

/** A minimal in-memory FileSystem over a Map — enough for the Curator's
 *  exists/read/write delta-merge paths (list/glob are unused here). */
const makeFs = (store: Map<string, string>) =>
  Layer.succeed(FileSystem, {
    read: (path: string) => {
      const content = store.get(path)
      return content === undefined
        ? Effect.fail(new FileNotFound({ path }))
        : Effect.succeed({
            content,
            truncated: false,
            totalLines: content.split("\n").length,
          } satisfies FileReadResult)
    },
    write: (path: string, content: string) =>
      Effect.sync(() => void store.set(path, content)),
    exists: (path: string) => Effect.succeed(store.has(path)),
    list: () => Effect.succeed([]),
    glob: () => Effect.succeed([]),
  })

const cand = (
  kind: CandidateKind,
  name: string,
  body: string,
  description = "d",
  scope: Candidate["scope"] = "project",
): Candidate => ({
  kind,
  name,
  description,
  body,
  scope,
  source: "inferred",
  evidence: { conversationId: "c", positions: [] },
})

const run = (store: Map<string, string>, c: Candidate) =>
  Effect.runPromise(persistArtifact("/repo", c).pipe(Effect.provide(makeFs(store))))

describe("persistArtifact — Curator (deterministic delta merge)", () => {
  it("constraint: creates the file, then updates the SAME id in place (no duplicate)", async () => {
    const store = new Map<string, string>()
    const path = "/repo/.efferent/CONSTRAINTS.md"

    await run(store, cand("constraint", "run-typecheck", "Run typecheck after edits."))
    expect(store.get(path)).toContain("# Constraints")
    expect(store.get(path)).toContain("- [run-typecheck] (✓0 ✗0) Run typecheck after edits.")

    // Same id → update in place, NOT a second bullet.
    await run(store, cand("constraint", "run-typecheck", "Always run bun run typecheck."))
    const after = store.get(path)!
    expect(after).toContain("Always run bun run typecheck.")
    expect(after.match(/\[run-typecheck\]/g)?.length).toBe(1)

    // A different id → append a second bullet, header preserved.
    await run(store, cand("constraint", "no-secrets", "Never commit secrets."))
    const bullets = store
      .get(path)!
      .split("\n")
      .filter((l) => l.startsWith("- ["))
    expect(bullets.length).toBe(2)
  })

  it("process: a meta rule lands in the prompt overlay (delta bullet), not CONSTRAINTS", async () => {
    const store = new Map<string, string>()
    const overlay = "/repo/.efferent/prompts/coder.md"
    await run(store, cand("process", "plan-first", "Before a multi-step task, write the plan and confirm it."))
    expect(store.get(overlay)).toContain("- [plan-first] Before a multi-step task")
    expect(store.has("/repo/.efferent/CONSTRAINTS.md")).toBe(false)
    // Same id → update in place (delta-merge), not a second bullet.
    await run(store, cand("process", "plan-first", "Always plan first and confirm the decomposition."))
    expect(store.get(overlay)).toContain("Always plan first")
    expect(store.get(overlay)!.match(/\[plan-first\]/g)?.length).toBe(1)
  })

  it("routes by scope: global → the global root, project → the project root", async () => {
    const store = new Map<string, string>()
    const provide = <A>(eff: Effect.Effect<A, unknown, FileSystem>) =>
      Effect.runPromise(eff.pipe(Effect.provide(makeFs(store))))
    // project-scoped (default) lands under /repo; global under /home — same call, globalRoot="/home".
    await provide(persistArtifact("/repo", cand("constraint", "local-rule", "stay local."), undefined, "/home"))
    await provide(
      persistArtifact("/repo", cand("constraint", "use-const", "Use const.", "d", "global"), undefined, "/home"),
    )
    expect(store.get("/repo/.efferent/CONSTRAINTS.md")).toContain("stay local.")
    expect(store.get("/home/.efferent/CONSTRAINTS.md")).toContain("Use const.")
    expect([...store.keys()].some((k) => k.startsWith("/repo") && k.includes("use-const"))).toBe(false)
  })

  it("skill: writes once with frontmatter and never clobbers an existing file", async () => {
    const store = new Map<string, string>()
    const path = "/repo/.efferent/skills/my-skill.md"

    const r1 = await run(store, cand("skill", "my-skill", "body v1"))
    expect(r1.created).toBe(true)
    expect(store.get(path)).toContain("source: distilled")
    expect(store.get(path)).toContain("body v1")

    const r2 = await run(store, cand("skill", "my-skill", "body v2"))
    expect(r2.created).toBe(false)
    expect(store.get(path)).toContain("body v1")
    expect(store.get(path)).not.toContain("body v2")
  })

  it("memory: creates with frontmatter, then appends a timestamped entry", async () => {
    const store = new Map<string, string>()
    const path = "/repo/.efferent/memory/arch.md"

    await run(store, cand("memory", "arch", "We use Effect layers."))
    expect(store.get(path)).toContain("title:")

    await run(store, cand("memory", "arch", "Second note."))
    const doc = store.get(path)!
    expect(doc).toContain("Second note.")
    expect((doc.match(/^## /gm)?.length ?? 0)).toBeGreaterThanOrEqual(2)
  })

  it("slugifies the candidate name into the filename", async () => {
    const store = new Map<string, string>()
    await run(store, cand("skill", "My Cool Skill!", "body"))
    expect([...store.keys()]).toContain("/repo/.efferent/skills/my-cool-skill.md")
  })
})
