import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LocalFileSystemLive } from "@xandreed/providers"
import { MemoryId, MemoryRecord } from "../memory/domain.js"
import type { MemoryTopic } from "../memory/domain.js"
import { discoverSkills, SKILLS_DIR } from "./skills.js"
import {
  distilledSkillName,
  distillSkillsFromMemory,
  renderDistilledSkill,
  SKILL_DISTILL_MIN_CORROBORATION,
} from "./distill.js"

const record = (topic: MemoryTopic, statement: string, corroboration: number): MemoryRecord =>
  new MemoryRecord({
    // The id is irrelevant to distillation (it filters by topic + count) — a
    // statement-derived stem keeps records distinct without a mutable counter.
    id: MemoryId.make(statement.replace(/\W+/g, "-").slice(0, 24)),
    topic,
    statement,
    corroboration,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    sources: ["r0"],
  })

const run = (cwd: string, actives: ReadonlyArray<MemoryRecord>) =>
  Effect.runPromise(
    distillSkillsFromMemory({ cwd, actives }).pipe(Effect.provide(LocalFileSystemLive)),
  )

const skillPath = (cwd: string, topic: MemoryTopic) =>
  join(cwd, SKILLS_DIR, `${distilledSkillName(topic)}.md`)

describe("renderDistilledSkill", () => {
  test("frontmatter name/description + a confirmed-count checklist", () => {
    const body = renderDistilledSkill("convention", [
      record("convention", "barrel files are forbidden", 4),
    ])
    expect(body).toContain("name: learned-convention")
    expect(body).toContain("description: 1 convention fact")
    expect(body).toContain("AUTO-DISTILLED")
    expect(body).toContain("- barrel files are forbidden (confirmed ×4)")
  })
})

describe("distillSkillsFromMemory", () => {
  test("only memories at/above the bar become skills; sub-threshold topics don't", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-distill-"))
    const names = await run(cwd, [
      record("convention", "barrel files are forbidden", SKILL_DISTILL_MIN_CORROBORATION),
      record("gotcha", "flaky only under --watch", SKILL_DISTILL_MIN_CORROBORATION - 1),
    ])
    expect(names).toEqual(["learned-convention"])
    expect(existsSync(skillPath(cwd, "convention"))).toBe(true)
    expect(existsSync(skillPath(cwd, "gotcha"))).toBe(false)
    // The distilled file is a REAL skill the discovery step then surfaces.
    const discovered = await Effect.runPromise(
      discoverSkills(cwd).pipe(Effect.provide(LocalFileSystemLive)),
    )
    expect(discovered.map((s) => s.name)).toContain("learned-convention")
  })

  test("within a topic, most-confirmed first", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-distill-"))
    await run(cwd, [
      record("dependency", "effect 3.x needs exactOptionalPropertyTypes", 3),
      record("dependency", "bun:sqlite has no WAL by default", 5),
    ])
    const body = readFileSync(skillPath(cwd, "dependency"), "utf-8")
    expect(body.indexOf("WAL")).toBeLessThan(body.indexOf("exactOptional"))
  })

  test("a topic that falls below the bar has its stale skill REMOVED", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-distill-"))
    // A stale distilled file from a prior, higher-corroboration run.
    mkdirSync(join(cwd, SKILLS_DIR), { recursive: true })
    writeFileSync(skillPath(cwd, "build-quirk"), "---\nname: learned-build-quirk\ndescription: old\n---\nstale")
    const names = await run(cwd, [record("build-quirk", "needs --preload", 1)])
    expect(names).toEqual([])
    expect(existsSync(skillPath(cwd, "build-quirk"))).toBe(false)
  })
})
