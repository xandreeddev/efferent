import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FileSystem } from "../ports/file-system.port.js"
import { makeMemoryFileSystem } from "../workspace/file-system.memory.adapter.js"
import type { MemorySeed } from "../workspace/file-system.memory.adapter.js"
import { collectSkillFiles, readSkillFiles, skillsFromFiles } from "./skill-files.entity.functions.js"
import type { SkillFile } from "./skill-files.entity.js"

const file = (path: string, text: string): SkillFile => ({ path, text })
const skillsOf = (files: ReadonlyArray<SkillFile>, options?: Parameters<typeof readSkillFiles>[1]) => readSkillFiles(files, options).skills.map((entry) => entry.skill)
const byId = (files: ReadonlyArray<SkillFile>, id: string) => skillsOf(files).find((skill) => skill.id === id)

describe("readSkillFiles: fields", () => {
  test("reads the Agent Skills fields as aliases: name for id, description for summary; id and summary win", () => {
    const skills = skillsOf([
      file("commit/SKILL.md", "---\nname: commit-style\ndescription: How to write a commit.\nlicense: MIT\n---\n\n# Commit\n\nUse the imperative.\n"),
      file("both/SKILL.md", "---\nid: own-id\nname: other\nsummary: The summary.\ndescription: Not this.\n---\nBody"),
    ])
    expect(skills.map((skill) => [skill.id, skill.summary, skill.instructions])).toEqual([
      ["own-id", "The summary.", "Body"],
      ["commit-style", "How to write a commit.", "# Commit\n\nUse the imperative."],
    ])
  })

  test("tools and permissions are lists, or text split on commas and spaces; always is true or false", () => {
    const [skill] = skillsOf([file("a/SKILL.md", "---\ndescription: d\ntools: lookup, deliver  search\npermissions:\n  - net.read\n  - \"fs.write\"\nalways: True\n---\n")])
    expect([skill?.tools, skill?.permissions, skill?.always]).toEqual([["lookup", "deliver", "search"], ["net.read", "fs.write"], true])
    const [flow] = skillsOf([file("b/SKILL.md", "---\ndescription: d\ntools: [lookup, 'deliver']\n---\n")])
    expect(flow?.tools).toEqual(["lookup", "deliver"])
  })

  test("tools: ignore drops the tools a skill declares", () => {
    expect(skillsOf([file("a/SKILL.md", "---\ndescription: d\ntools: lookup\n---\n")], { tools: "ignore" })[0]?.tools).toEqual([])
  })

  test("a byte-order mark and CRLF line ends are read as if absent", () => {
    const [skill] = skillsOf([file("a/SKILL.md", "﻿---\r\nname: crlf\r\ndescription: Windows line ends.\r\n---\r\nLine one\r\nLine two\r\n")])
    expect([skill?.id, skill?.summary, skill?.instructions]).toEqual(["crlf", "Windows line ends.", "Line one\nLine two"])
  })

  test("block scalars fold (>) or keep (|) their lines; quotes and comments are read as YAML reads them", () => {
    const [folded] = skillsOf([file("a/SKILL.md", "---\nname: \"quoted: name\" \ndescription: >\n  One long\n  description.\nversion: '2' # pinned\n---\n")])
    expect([folded?.id, folded?.summary, folded?.version]).toEqual(["quoted: name", "One long description.", "2"])
    const [kept] = skillsOf([file("b/SKILL.md", "---\ndescription: d\nversion: |-\n  first\n  second\n---\n")])
    expect(kept?.version).toBe("first\nsecond")
  })

  test("the summary is one line, the catalogue's, whatever block it was written as", () => {
    const summaries = skillsOf([
      file("a/SKILL.md", "---\ndescription: |\n  Kept\n  lines.\n---\n"),
      file("b/SKILL.md", "---\ndescription: >\n  First\n  paragraph.\n\n  Second   one.\n---\n"),
    ]).map((skill) => skill.summary)
    expect(summaries).toEqual(["Kept lines.", "First paragraph. Second one."])
  })

  test("a nested map's keys never stand in for top-level ones", () => {
    const [skill] = skillsOf([file("dir/SKILL.md", "---\nmetadata:\n  name: shadow\n  description: shadow\ndescription: The real one.\n---\n")])
    expect([skill?.id, skill?.summary]).toEqual(["dir", "The real one."])
  })
})

describe("readSkillFiles: the tree", () => {
  const tree = [
    file("README.md", "# not a skill: outside every skill directory"),
    file("git/SKILL.md", "---\ndescription: Git.\n---\nSee references/style.md."),
    file("git/references/style.md", "---\ntitle: Commit style\n---\n\nShort titles.\n"),
    file("git/scripts/check.sh", "#!/bin/sh\necho ok\n"),
    file("git/rebase/SKILL.md", "---\ndescription: Rebasing.\n---\nRebase."),
    file("git/rebase/notes.md", "# Rebase notes\n\nKeep it linear."),
    file("tools/lint/SKILL.md", "---\ndescription: Lint.\n---\n"),
  ]

  test("every SKILL.md at any depth is a skill, its id the directory path when the frontmatter names none", () => {
    expect(skillsOf(tree).map((skill) => skill.id)).toEqual(["git", "git/rebase", "tools/lint"])
    expect(readSkillFiles(tree).skills.map((entry) => entry.directory)).toEqual(["git", "git/rebase", "tools/lint"])
  })

  test("a skill's other files are its references, by path below its directory; a nested skill's files are its own", () => {
    expect(byId(tree, "git")?.references).toEqual([
      { id: "references/style.md", title: "Commit style", text: "Short titles." },
      { id: "scripts/check.sh", title: "scripts/check.sh", text: "#!/bin/sh\necho ok" },
    ])
    expect(byId(tree, "git/rebase")?.references).toEqual([{ id: "notes.md", title: "Rebase notes", text: "# Rebase notes\n\nKeep it linear." }])
  })

  test("a SKILL.md at the root is named by its frontmatter, else by rootName, else it is an error", () => {
    const root = [file("SKILL.md", "---\ndescription: The root.\n---\n"), file("guide.md", "# Guide")]
    expect(skillsOf(root, { rootName: "skills" }).map((skill) => [skill.id, skill.references.map((reference) => reference.id)])).toEqual([["skills", ["guide.md"]]])
    expect(readSkillFiles(root).issues).toEqual([{ path: "SKILL.md", severity: "error", message: "a SKILL.md at the root names its skill: give it an id or a name" }])
    expect(skillsOf([file("./SKILL.md", "---\nname: named\ndescription: d\n---\n")]).map((skill) => skill.id)).toEqual(["named"])
  })

  test("the default version is a fingerprint of the skill as read: a change to its SKILL.md or a reference changes it", () => {
    const version = (files: ReadonlyArray<SkillFile>) => byId(files, "git")?.version
    const edited = tree.map((item) => item.path === "git/scripts/check.sh" ? file(item.path, "echo changed") : item)
    expect(version(tree)).toBe(version([...tree]))
    expect(version(edited)).not.toBe(version(tree))
    expect(byId(tree, "git/rebase")?.version).toBe(byId([...tree.slice(4)], "git/rebase")?.version)
  })

  test("a skill that cannot be read is an error and the others load", () => {
    const read = readSkillFiles([
      file("bare/SKILL.md", "no frontmatter"),
      file("mute/SKILL.md", "---\nname: mute\n---\n"),
      file("one/SKILL.md", "---\nname: same\ndescription: First.\n---\n"),
      file("two/SKILL.md", "---\nname: same\ndescription: Second.\n---\n"),
    ])
    expect(read.skills.map((entry) => [entry.skill.id, entry.skill.summary])).toEqual([["same", "First."]])
    expect(read.issues).toEqual([
      { path: "bare/SKILL.md", severity: "error", message: "no frontmatter: a SKILL.md opens with a --- fence holding at least a description" },
      { path: "mute/SKILL.md", severity: "error", message: "no description: the frontmatter needs a description (or summary)" },
      { path: "two/SKILL.md", severity: "error", message: "the skill id same is already used by one/SKILL.md" },
    ])
  })

  test("a reference over maxReferenceBytes is left out with a warning; unreadable values warn", () => {
    const read = readSkillFiles([
      file("a/SKILL.md", "---\ndescription: d\nalways: yes\nnot a key\n---\n"),
      file("a/big.md", "é".repeat(6)),
      file("a/small.md", "12345"),
    ], { maxReferenceBytes: 10 })
    expect(read.skills[0]?.skill.references.map((reference) => reference.id)).toEqual(["small.md"])
    expect(read.skills[0]?.skill.always).toBe(false)
    expect(read.issues).toEqual([
      { path: "a/SKILL.md", severity: "warning", message: "frontmatter line 4 is not `key: value` and was not read" },
      { path: "a/SKILL.md", severity: "warning", message: "always is true or false, not \"yes\"; read as false" },
      { path: "a/big.md", severity: "warning", message: "left out: 12 bytes, more than the 10-byte reference limit (maxReferenceBytes)" },
    ])
  })

  test("a reference that is not valid is left out with a warning, and the skill loads without it", () => {
    const read = readSkillFiles([
      file("a/SKILL.md", "---\ndescription: d\n---\n"),
      file("a/empty-heading.md", "# \n\n# Real title\n"),
      file("a/bare-heading.md", "# \n\nNo title at all."),
      file("a/ spaced.md", "text"),
    ])
    expect(read.skills[0]?.skill.references.map((reference) => [reference.id, reference.title])).toEqual([
      ["bare-heading.md", "bare-heading.md"],
      ["empty-heading.md", "Real title"],
    ])
    expect(read.issues.map((found) => [found.path, found.severity, found.message.startsWith("left out: not a valid reference")])).toEqual([["a/ spaced.md", "warning", true]])
  })

  test("a file collected with its size and no text (over maxFileBytes) is left out with a warning", () => {
    const read = readSkillFiles([
      file("a/SKILL.md", "---\ndescription: d\n---\n"),
      { path: "a/data.json", text: "", size: 70_000 },
      { path: "b/SKILL.md", text: "", size: 70_000 },
    ], { maxReferenceBytes: 65_536 })
    expect(read.skills.map((entry) => [entry.skill.id, entry.skill.references.length])).toEqual([["a", 0]])
    expect(read.issues).toEqual([
      { path: "a/data.json", severity: "warning", message: "left out: 70000 bytes, more than the 65536-byte reference limit (maxReferenceBytes)" },
      { path: "b/SKILL.md", severity: "error", message: "not read: 70000 bytes, too large to be read (maxFileBytes)" },
    ])
  })
})

describe("skillsFromFiles", () => {
  test("is readSkillFiles, strict: any issue fails with skills.files naming each", async () => {
    const skills = await Effect.runPromise(skillsFromFiles([
      file("triage/SKILL.md", "---\nsummary: Triage.\ntools: lookup\nalways: true\n---\nTriage first."),
      file("triage/references/formats.md", "# Formats\n\nISO dates."),
    ]))
    expect(skills.map((skill) => [skill.id, skill.tools, skill.always, skill.references.map((reference) => [reference.id, reference.title])])).toEqual([
      ["triage", ["lookup"], true, [["references/formats.md", "Formats"]]],
    ])
    const error = await Effect.runPromise(Effect.flip(skillsFromFiles([file("a/SKILL.md", "---\nname: a\n---\n"), file("b/SKILL.md", "plain")])))
    expect([error.code, error.message]).toEqual(["skills.files",
      "a/SKILL.md: no description: the frontmatter needs a description (or summary); b/SKILL.md: no frontmatter: a SKILL.md opens with a --- fence holding at least a description"])
  })
})

describe("collectSkillFiles", () => {
  const collect = (seed: Readonly<Record<string, MemorySeed>>, maxFiles = 100, maxBytes = 10_000, maxFileBytes?: number) => Effect.runPromise(Effect.result(Effect.gen(function* () {
    const fs = yield* makeMemoryFileSystem(seed)
    return yield* collectSkillFiles("/skills", { maxFiles, maxBytes, ...(maxFileBytes === undefined ? {} : { maxFileBytes }) }).pipe(Effect.provideService(FileSystem, fs))
  })))

  test("reads the text files under the root by relative path; binary files, dot entries and node_modules are left out", async () => {
    const result = await collect({
      "/skills/a/SKILL.md": "---\ndescription: d\n---\n",
      "/skills/a/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]),
      "/skills/a/latin1.txt": new Uint8Array([0x63, 0x61, 0xe9]),
      "/skills/a/.hidden": "secret",
      "/skills/.git/config": "x",
      "/skills/a/node_modules/dep/index.js": "x",
      "/skills/b/SKILL.md": "---\ndescription: b\n---\n",
      "/elsewhere/SKILL.md": "x",
    })
    expect(result).toMatchObject({ _tag: "Success", success: [
      { path: "a/SKILL.md", text: "---\ndescription: d\n---\n" },
      { path: "b/SKILL.md", text: "---\ndescription: b\n---\n" },
    ] })
  })

  test("more files than maxFiles, or more text than maxBytes, fails with skills.limit", async () => {
    const seed = { "/skills/a/SKILL.md": "x".repeat(40), "/skills/a/one.md": "y".repeat(40), "/skills/a/two.md": "z".repeat(40) }
    expect(await collect(seed, 2)).toMatchObject({ _tag: "Failure", failure: { code: "skills.limit", message: "/skills holds more than 2 files (maxFiles)" } })
    expect(await collect(seed, 3, 100)).toMatchObject({ _tag: "Failure", failure: { code: "skills.limit", message: "the text files under /skills hold more than 100 bytes (maxBytes)" } })
    expect(await collect(seed, 3, 120)).toMatchObject({ _tag: "Success" })
  })

  test("a binary file does not count toward maxBytes: told by its first 8 KB, or by all of it when read whole", async () => {
    const latin1 = new Uint8Array(20_000).fill(0x61).map((byte, index) => index === 10 ? 0xe9 : byte)
    const lateNul = new Uint8Array(20_000).fill(0x61).map((byte, index) => index === 15_000 ? 0 : byte)
    const skill = { "/skills/a/SKILL.md": "---\ndescription: d\n---\n" }
    expect(await collect({ ...skill, "/skills/a/latin1.txt": latin1 }, 100, 1_000)).toMatchObject({ _tag: "Success", success: [{ path: "a/SKILL.md" }] })
    expect(await collect({ ...skill, "/skills/a/late-nul.bin": lateNul }, 100, 1_000, 50_000)).toMatchObject({ _tag: "Success", success: [{ path: "a/SKILL.md" }] })
    // Without maxFileBytes the budget bounds the read, and a NUL past it is not seen.
    expect(await collect({ ...skill, "/skills/a/late-nul.bin": lateNul }, 100, 1_000)).toMatchObject({ _tag: "Failure", failure: { code: "skills.limit" } })
  })

  test("a file other than a SKILL.md over maxFileBytes is collected with its size and no text, and does not count toward maxBytes", async () => {
    const seed = { "/skills/a/SKILL.md": "s".repeat(30), "/skills/a/small.md": "y".repeat(20), "/skills/a/mid.md": "m".repeat(100), "/skills/a/big.md": "z".repeat(10_000), "/skills/b/SKILL.md": "x".repeat(60) }
    expect(await collect(seed, 100, 200, 50)).toMatchObject({ _tag: "Success", success: [
      { path: "a/SKILL.md", text: "s".repeat(30) },
      { path: "a/big.md", text: "", size: 10_000 },
      { path: "a/mid.md", text: "", size: 100 },
      { path: "a/small.md", text: "y".repeat(20) },
      { path: "b/SKILL.md", text: "x".repeat(60) },
    ] })
    expect(await collect(seed, 100, 200)).toMatchObject({ _tag: "Failure", failure: { code: "skills.limit" } })
  })

  test("a root that is missing fails with the FsError", async () => {
    expect(await collect({ "/other/SKILL.md": "x" })).toMatchObject({ _tag: "Failure", failure: { _tag: "FsError", reason: "NotFound" } })
  })
})
