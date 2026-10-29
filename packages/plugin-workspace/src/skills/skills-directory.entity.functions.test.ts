import { describe, expect, test } from "bun:test"
import { Effect, Exit, Option, Tracer } from "effect"
import { defineSkill, readSkillFiles } from "@xandreed/core"
import type { HarnessError } from "@xandreed/core"
import { alwaysSkillsText, mergeSkillRoots, settleSkills, skillsCapability } from "./skills-directory.entity.functions.js"

const skillFile = (path: string, name: string, description: string) => ({ path, text: `---\nname: ${name}\ndescription: ${description}\n---\n` })

describe("mergeSkillRoots", () => {
  test("prefixes every id, keeps the first root's skill on a clash and makes every issue's path absolute", () => {
    const project = readSkillFiles([skillFile("git/SKILL.md", "git", "Project git."), { path: "broken/SKILL.md", text: "no fence" }])
    const user = readSkillFiles([skillFile("git/SKILL.md", "git", "User git."), skillFile("SKILL.md", "notes", "User notes.")])
    const found = mergeSkillRoots([{ root: "/work/.agents/skills", tree: project }, { root: "/srv/team-skills/", tree: user }], "ws.")
    expect(found.skills.map((skill) => [skill.id, skill.summary])).toEqual([["ws.git", "Project git."], ["ws.notes", "User notes."]])
    expect(found.issues).toEqual([
      { path: "/work/.agents/skills/broken/SKILL.md", severity: "error", message: "no frontmatter: a SKILL.md opens with a --- fence holding at least a description" },
      { path: "/srv/team-skills/git/SKILL.md", severity: "error", message: "the skill id ws.git is already loaded from /work/.agents/skills/git/SKILL.md" },
    ])
  })
})

describe("settleSkills", () => {
  const found = { skills: [defineSkill({ id: "a", summary: "A.", tools: [] }), defineSkill({ id: "b", summary: "B.", tools: [] })], issues: [{ path: "/r/x/SKILL.md", severity: "error" as const, message: "no description" }] }

  test("strict fails with skills.files on any issue; lenient keeps the skills that loaded", async () => {
    expect(await Effect.runPromise(Effect.flip(settleSkills(found, { strict: true, maxSkills: 10 })))).toMatchObject({ code: "skills.files", message: "/r/x/SKILL.md: no description" })
    expect((await Effect.runPromise(settleSkills(found, { strict: false, maxSkills: 10 }))).map((skill) => skill.id)).toEqual(["a", "b"])
  })

  test("more skills than maxSkills fails with skills.limit", async () => {
    expect(await Effect.runPromise(Effect.flip(settleSkills(found, { strict: false, maxSkills: 1 })))).toMatchObject({ code: "skills.limit", message: "found 2 skills, more than 1 (maxSkills)" })
  })

  test("each settle is one skills.settle span, ended with its failure", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({ span: (options) => { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
    await Effect.runPromise(Effect.all([settleSkills(found, { strict: false, maxSkills: 10 }), Effect.flip(settleSkills(found, { strict: true, maxSkills: 10 }))], { concurrency: 1 }).pipe(Effect.withTracer(tracer)))
    expect(spans.map((span) => span.name)).toEqual(["skills.settle", "skills.settle"])
    expect(spans.map((span) => span.status._tag === "Ended" && Exit.isFailure(span.status.exit))).toEqual([false, true])
  })
})

describe("the always-on section", () => {
  // An always-on skill with instructions, as a SKILL.md with `always: true` reads (defineSkill takes none for one).
  const skills = [
    { ...defineSkill({ id: "style", summary: "House style.", instructions: "Write short sentences.", tools: [],
      references: [{ id: "references/words.md", title: "Words", text: "..." }] }), always: true },
    defineSkill({ id: "rare", summary: "Rarely needed.", tools: [] }),
  ]

  test("renders the always-on skills' instructions and references, and nothing without one", () => {
    expect(alwaysSkillsText(skills)).toEqual(Option.some("## Always-on skills\n\n### style\nWrite short sentences.\nReferences (read_skill_reference): references/words.md — Words"))
    expect(alwaysSkillsText(skills.slice(1))).toEqual(Option.none())
  })

  test("is a static section of the capability unless alwaysSection is off; the capability's version follows the skills'", async () => {
    const on = skillsCapability(skills, { alwaysSection: true, sectionOrder: 850 })
    expect(on.promptSections.map((section) => [section.id, section.tier, section.order])).toEqual([["workspace.skills.always", "static", 850]])
    const rendered = on.promptSections[0]!.render({ variant: Option.none(), active: [], skills }) as Effect.Effect<Option.Option<string>, HarnessError>
    expect(await Effect.runPromise(rendered)).toEqual(alwaysSkillsText(skills))
    expect(skillsCapability(skills, { alwaysSection: false, sectionOrder: 850 }).promptSections).toEqual([])
    expect(skillsCapability(skills.slice(1), { alwaysSection: true, sectionOrder: 1 }).version).not.toBe(on.version)
  })
})
