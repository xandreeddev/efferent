import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { LocalFileSystemLive, LocalShellLive } from "@xandreed/providers"
import { makeSmithCodingHandlers } from "../implementor/codingToolkit.js"
import { discoverSkills, readSkill, renderSkillsBlock, SKILLS_DIR } from "./skills.js"

const seed = (cwd: string, name: string, content: string): void => {
  mkdirSync(join(cwd, SKILLS_DIR), { recursive: true })
  writeFileSync(join(cwd, SKILLS_DIR, `${name}.md`), content)
}

const SKILL = `---
name: effect-idioms
description: House Effect.ts patterns; load when writing Effect code here.
---
# Effect idioms
- errors are values
- state is a fold`

const run = <A>(cwd: string, effect: Effect.Effect<A, never, never>): Promise<A> =>
  Effect.runPromise(effect)

describe("agent skills — progressive disclosure", () => {
  test("tier 1: metadata discovered; invalid/undescribed files skip; absent dir = empty", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "skills-"))
    seed(cwd, "effect-idioms", SKILL)
    seed(cwd, "no-frontmatter", "just a body, no frontmatter")
    seed(cwd, "no-description", "---\nname: shy\n---\nbody")
    const skills = await run(
      cwd,
      discoverSkills(cwd).pipe(Effect.provide(LocalFileSystemLive)),
    )
    // Workspace skills first; smith's BUNDLED skills (mechanism know-how)
    // ride beneath them.
    expect(skills[0]).toEqual({
      name: "effect-idioms",
      description: "House Effect.ts patterns; load when writing Effect code here.",
    })
    expect(skills.map((s) => s.name)).toContain("gate-rule-authoring")
    const block = renderSkillsBlock(skills)
    expect(block).toContain("Skills available")
    expect(block).toContain("- effect-idioms:")
    expect(renderSkillsBlock([])).toBe("")

    // An absent workspace dir still surfaces the bundled skills — and a
    // workspace file with a bundled name SHADOWS it.
    const none = await run(
      mkdtempSync(join(tmpdir(), "skills-empty-")),
      discoverSkills(cwd + "-nope").pipe(Effect.provide(LocalFileSystemLive)),
    )
    expect(none.map((s) => s.name)).toEqual(["gate-rule-authoring"])
    const shadowed = mkdtempSync(join(tmpdir(), "skills-shadow-"))
    seed(shadowed, "gate-rule-authoring", "---\nname: gate-rule-authoring\ndescription: project-specific override\n---\nbody")
    const winners = await run(
      shadowed,
      discoverSkills(shadowed).pipe(Effect.provide(LocalFileSystemLive)),
    )
    expect(winners).toEqual([
      { name: "gate-rule-authoring", description: "project-specific override" },
    ])
  })

  test("tier 2: readSkill returns the body; path-shaped names are refused", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "skills-"))
    seed(cwd, "effect-idioms", SKILL)
    const body = await run(
      cwd,
      readSkill(cwd, "effect-idioms").pipe(Effect.provide(LocalFileSystemLive)),
    )
    expect(Option.getOrThrow(body)).toContain("state is a fold")
    const traversal = await run(
      cwd,
      readSkill(cwd, "../../etc/passwd").pipe(Effect.provide(LocalFileSystemLive)),
    )
    expect(Option.isNone(traversal)).toBe(true)
  })

  test("the load_skill tool: round-trip, and unknown names fail as data naming the available", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "skills-"))
    seed(cwd, "effect-idioms", SKILL)
    await Effect.runPromise(
      makeSmithCodingHandlers(cwd).pipe(
        Effect.flatMap((h) =>
          Effect.gen(function* () {
            const loaded = yield* h.load_skill({ name: "effect-idioms" })
            expect(loaded.instructions).toContain("errors are values")
            const unknown = yield* h.load_skill({ name: "nope" }).pipe(Effect.either)
            expect(unknown._tag).toBe("Left")
            expect(JSON.stringify(unknown)).toContain("effect-idioms")
          }),
        ),
        Effect.provide(LocalFileSystemLive),
        Effect.provide(LocalShellLive),
      ) as Effect.Effect<void>,
    )
  })
})
