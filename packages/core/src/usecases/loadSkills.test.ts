import { describe, expect, it } from "bun:test"
import { Effect, FastCheck as fc, Layer } from "effect"
import { FileNotFound, FileSystem } from "../ports/FileSystem.js"
import { loadSkills } from "./loadSkills.js"

/**
 * In-memory FileSystem: `files` maps absolute path → content. `list` returns
 * direct children (the only mode loadSkills uses); `unreadable` paths are
 * listed but fail on read — the listed-but-unreadable branch.
 */
const fsLayer = (
  files: Record<string, string>,
  opts?: { relativePaths?: boolean; unreadable?: ReadonlyArray<string> },
) =>
  Layer.succeed(
    FileSystem,
    FileSystem.of({
      read: (path: string) => {
        const content = files[path]
        return content !== undefined && !(opts?.unreadable ?? []).includes(path)
          ? Effect.succeed({ content, truncated: false, totalLines: content.split("\n").length })
          : Effect.fail(new FileNotFound({ path }))
      },
      list: (dir: string) => {
        const prefix = dir.endsWith("/") ? dir : `${dir}/`
        const entries = Object.keys(files)
          .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
          .map((p) => ({
            path: opts?.relativePaths === true ? p.slice(prefix.length) : p,
            type: "file" as const,
          }))
        return entries.length > 0
          ? Effect.succeed(entries)
          : Effect.fail(new FileNotFound({ path: dir }))
      },
      write: () => Effect.die("unused"),
      exists: () => Effect.die("unused"),
      glob: () => Effect.die("unused"),
    } as never),
  )

const skillFile = (name: string, description: string, body = "do the thing"): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

const run = (
  files: Record<string, string>,
  opts?: Parameters<typeof fsLayer>[1],
  cwd = "/ws/app",
  home = "/home/u",
) => Effect.runPromise(loadSkills(cwd, home).pipe(Effect.provide(fsLayer(files, opts))))

describe("loadSkills", () => {
  it("discovers .md skills in cwd's skills dir, parses frontmatter, sorts by name", async () => {
    const skills = await run({
      "/ws/app/.efferent/skills/b.md": skillFile("zeta", "last alphabetically"),
      "/ws/app/.efferent/skills/a.md": skillFile("alpha", "first alphabetically"),
    })
    expect(skills.map((s) => s.name)).toEqual(["alpha", "zeta"])
    expect(skills[0]).toEqual({
      name: "alpha",
      description: "first alphabetically",
      sourcePath: "/ws/app/.efferent/skills/a.md",
    })
  })

  it("closer-to-cwd shadows farther on name collisions; home is searched last", async () => {
    const skills = await run({
      "/ws/app/.efferent/skills/fmt.md": skillFile("fmt", "from cwd"),
      "/ws/.efferent/skills/fmt.md": skillFile("fmt", "from parent"),
      "/home/u/.efferent/skills/fmt.md": skillFile("fmt", "from home"),
      "/home/u/.efferent/skills/extra.md": skillFile("homer", "unique to home"),
    })
    expect(skills.map((s) => [s.name, s.description])).toEqual([
      ["fmt", "from cwd"],
      ["homer", "unique to home"],
    ])
  })

  it("skips malformed, non-md, and unreadable files without failing", async () => {
    const skills = await run(
      {
        "/ws/app/.efferent/skills/good.md": skillFile("good", "valid"),
        "/ws/app/.efferent/skills/no-fence.md": "just a markdown body, no frontmatter",
        "/ws/app/.efferent/skills/missing-desc.md": "---\nname: incomplete\n---\nbody",
        "/ws/app/.efferent/skills/unterminated.md": "---\nname: x\ndescription: y",
        "/ws/app/.efferent/skills/notes.txt": skillFile("texty", "wrong extension"),
        "/ws/app/.efferent/skills/locked.md": skillFile("locked", "cannot be read"),
      },
      { unreadable: ["/ws/app/.efferent/skills/locked.md"] },
    )
    expect(skills.map((s) => s.name)).toEqual(["good"])
  })

  it("strips quotes, ignores comments and unknown keys, keeps colons inside values", async () => {
    const content =
      `---\n# a comment line\nname: "quoted"\ndescription: usage: run it twice\nextra: ignored\n---\nbody`
    const skills = await run({ "/ws/app/.efferent/skills/q.md": content })
    expect(skills).toEqual([
      {
        name: "quoted",
        description: "usage: run it twice",
        sourcePath: "/ws/app/.efferent/skills/q.md",
      },
    ])
  })

  it("resolves relative listing entries against the skills dir", async () => {
    const skills = await run(
      { "/ws/app/.efferent/skills/rel.md": skillFile("rel", "listed relatively") },
      { relativePaths: true },
    )
    expect(skills[0]?.sourcePath).toBe("/ws/app/.efferent/skills/rel.md")
  })

  it("no skills dirs anywhere → empty, never a failure", async () => {
    expect(await run({})).toEqual([])
  })

  it("property: total on arbitrary file content — never throws, always an array", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 300 }), fc.fullUnicodeString({ maxLength: 300 })),
        (content) => {
          const skills = Effect.runSync(
            loadSkills("/ws/app", "/home/u").pipe(
              Effect.provide(fsLayer({ "/ws/app/.efferent/skills/fuzz.md": content })),
            ),
          )
          expect(Array.isArray(skills)).toBe(true)
          for (const s of skills) {
            expect(typeof s.name).toBe("string")
            expect(typeof s.description).toBe("string")
          }
        },
      ),
      { numRuns: 200 },
    )
  })
})
