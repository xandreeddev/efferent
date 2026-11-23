import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import type { FileDiff } from "./diff.entity.js"
import { CommitSha } from "./pull-request.entity.js"
import type { RepoSkill, SkillRoute } from "./repo-skills.entity.js"
import { NO_SKILLS, REVIEW_SKILLS_FILE, SECTIONS_NOTE, SkillRoutes } from "./repo-skills.entity.js"
import { callsFor, groupSkills, routedSkills, sectionsOf, skillsShown, termsOf } from "./repo-skills.entity.functions.js"

const FROM = CommitSha.make("a".repeat(40))
const route = (path: string, paths: ReadonlyArray<string>, diff: ReadonlyArray<string> = []): SkillRoute => ({ path, paths, diff })
const skill = (path: string, text: string, paths: ReadonlyArray<string> = [], diff: ReadonlyArray<string> = []): RepoSkill => ({ route: route(path, paths, diff), text, from: FROM })

describe("callsFor", () => {
  test.each([
    ["a path matches a glob", route("e.md", ["**/*.entity.ts"]), ["packages/a/src/x.entity.ts"], "", true],
    ["at the root too", route("e.md", ["**/*.entity.ts"]), ["x.entity.ts"], "", true],
    ["no glob matches", route("e.md", ["**/*.entity.ts"]), ["src/x.adapter.ts"], "", false],
    ["a glob of a folder", route("k.md", ["**/kernel/**"]), ["packages/sdk/src/kernel/a/b.ts"], "", true],
    ["the diff holds a word", route("e.md", [], ["Schema.Struct"]), ["src/lesson.ts"], "+ const A = Schema.Struct({", true],
    ["words are text, never a pattern", route("e.md", [], ["Schema.(Struct)"]), ["src/lesson.ts"], "+ const A = Schema.Struct({", false],
    ["no path and no word", route("e.md", [], []), ["src/a.ts"], "anything", false],
  ] as const)("%s", (_, one, paths, diff, calls) => {
    expect(callsFor(one, paths, diff)).toBe(calls)
  })
})

describe("routedSkills", () => {
  test("the skills called for, in the order their routes are declared", () => {
    const skills = [skill("a.md", "A", ["**/*.port.ts"]), skill("b.md", "B", ["**/*.entity.ts"]), skill("c.md", "C", [], ["@xandreed/sdk"])]
    expect(routedSkills(skills, ["src/x.entity.ts", "src/y.port.ts"], "").map((one) => one.route.path)).toEqual(["a.md", "b.md"])
    expect(routedSkills(skills, ["src/x.entity.ts"], "import { a } from \"@xandreed/sdk\"").map((one) => one.route.path)).toEqual(["b.md", "c.md"])
    expect(routedSkills(skills, ["README.md"], "")).toEqual([])
  })
})

describe("termsOf", () => {
  test("folders, stems and roles, lower case, three characters or more, common words left out", () => {
    expect(termsOf(["packages/review/src/review-tools.entity.functions.ts", "packages/review/src/vote.adapter.ts", "src/UI/ab.ts"])).toEqual([
      "review", "review-tools", "entity", "functions", "vote", "adapter",
    ])
  })
})

describe("sectionsOf", () => {
  test("what comes before the first level-two heading, then each with its body; deeper headings stay in their section", () => {
    expect(sectionsOf("# T\nintro\n## One\na\n### Sub\nb\n## Two\nc")).toEqual([
      { heading: "", body: "# T\nintro" },
      { heading: "## One", body: "a\n### Sub\nb" },
      { heading: "## Two", body: "c" },
    ])
  })
})

describe("skillsShown", () => {
  // Ports 671 characters with its heading, Entities 533 (the only one holding the term "entity"), Other over 3,000.
  const PORTS = "port rules ".repeat(60).trim()
  const ENTITIES = "entity rules ".repeat(40).trim()
  const long = () => `---\nname: x\n---\n# Title\nintro\n## Ports\n${PORTS}\n## Entities\n${ENTITIES}\n## Other\n${"other rules ".repeat(260)}`

  test("whole while they fit, each under File: <path>; none shown, nothing", () => {
    expect(skillsShown([skill("a/SKILL.md", "  rule A\n"), skill("b/SKILL.md", "rule B")], ["src/x.ts"])).toEqual({
      paths: ["a/SKILL.md", "b/SKILL.md"],
      text: "File: a/SKILL.md\nrule A\n\nFile: b/SKILL.md\nrule B\n",
    })
    expect(skillsShown([], ["src/x.ts"])).toEqual(NO_SKILLS)
  })

  test("a skill over the room left by its sections: the title, every heading, the best-ranked sections whole that fit, and the note", () => {
    const shown = skillsShown([skill("p/SKILL.md", long())], ["src/a.entity.ts"], 2_500)
    expect(shown).toEqual({
      paths: ["p/SKILL.md"],
      text: ["File: p/SKILL.md", "# Title", `## Ports\n${PORTS}`, `## Entities\n${ENTITIES}`, "## Other", `${SECTIONS_NOTE}\n`].join("\n"),
    })
    // With room for one of the two, the one holding the group's term ("entity") wins over the earlier one.
    const tight = skillsShown([skill("p/SKILL.md", long())], ["src/a.entity.ts"], 1_500)
    expect(tight.text).toBe(["File: p/SKILL.md", "# Title", "## Ports", `## Entities\n${ENTITIES}`, "## Other", `${SECTIONS_NOTE}\n`].join("\n"))
    // With no term held, the earlier section wins.
    expect(skillsShown([skill("p/SKILL.md", long())], ["src/a.ts"], 1_500).text).toContain(`## Ports\n${PORTS}\n## Entities\n## Other`)
  })

  test("an empty skill, a skill with no section that fits, and one past SKILL_ROOM_LEAST are not shown", () => {
    expect(skillsShown([skill("e/SKILL.md", "  \n")], [])).toEqual(NO_SKILLS)
    expect(skillsShown([skill("p/SKILL.md", `# T\n## Big\n${"x".repeat(2_000)}`)], [], 1_600)).toEqual(NO_SKILLS)
    const first = skill("a/SKILL.md", "a".repeat(1_000))
    expect(skillsShown([first, skill("b/SKILL.md", "b")], [], 2_000).paths).toEqual(["a/SKILL.md"])
  })
})

describe("the repository's own routes", () => {
  test("decode, name skills that exist, and route a port, an entity, a prompt and a lesson that imports the kernel", async () => {
    const root = join(import.meta.dir, "..", "..", "..")
    const routes = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(SkillRoutes))(readFileSync(join(root, REVIEW_SKILLS_FILE), "utf8")))
    expect(routes.skills.every((one) => existsSync(join(root, one.path)))).toBe(true)
    const skills = routes.skills.map((one) => ({ route: one, text: one.path, from: FROM }))
    const named = (paths: ReadonlyArray<string>, diff = "") => routedSkills(skills, paths, diff).map((one) => one.route.path.split("/")[2])
    expect([
      named(["packages/review/src/forge.port.ts"]),
      named(["packages/review/src/vote.entity.functions.ts"]),
      named(["packages/review/src/review-prompt.entity.ts"]),
      named(["packages/website/src/learn/lessons/tools/lesson.ts"], "import { callTool } from \"@xandreed/sdk\""),
      named(["packages/website/src/learn/board.ts"]),
    ]).toEqual([["add-port"], ["domain-entity"], ["domain-entity", "write-model-text"], ["kernel-architecture"], []])
  })
})

describe("groupSkills", () => {
  const file = (path: string, text: string): FileDiff => ({
    path, oldPath: Option.none(), change: "added", modeChange: Option.none(), binary: false, additions: 1, deletions: 0,
    hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, section: "", lines: [{ _tag: "Added", line: 1, text }] }],
  })

  test("routed by the group's paths and by its packed diff's words", () => {
    const skills = [skill("e/SKILL.md", "entity rules", ["**/*.entity.ts"], ["Schema.Struct"]), skill("k/SKILL.md", "kernel rules", [], ["@xandreed/sdk"])]
    expect(groupSkills(skills, [file("src/lesson.ts", "const A = Schema.Struct({})")], 24_000).paths).toEqual(["e/SKILL.md"])
    expect(groupSkills(skills, [file("src/a.entity.ts", "import { x } from \"@xandreed/sdk\"")], 24_000).paths).toEqual(["e/SKILL.md", "k/SKILL.md"])
    expect(groupSkills(skills, [file("src/lesson.ts", "const a = 1")], 24_000)).toEqual(NO_SKILLS)
    expect(groupSkills([], [file("src/a.entity.ts", "")], 24_000)).toEqual(NO_SKILLS)
  })
})
