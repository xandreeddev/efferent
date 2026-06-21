import { describe, expect, it } from "bun:test"
import { Effect, FastCheck as fc, Layer } from "effect"
import { FileNotFound, FileSystem } from "@xandreed/sdk-core"
import { loadMemory } from "./loadMemory.js"

/**
 * In-memory FileSystem: `files` maps absolute path → content. `list` returns
 * direct children (the only mode loadMemory uses); `unreadable` paths are
 * listed but fail on read — the listed-but-unreadable branch. Mirrors the
 * loadSkills test harness.
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

const memoryFile = (title: string, summary: string, body = "the rationale"): string =>
  `---\ntitle: ${title}\nsummary: ${summary}\n---\n\n${body}\n`

const run = (
  files: Record<string, string>,
  opts?: Parameters<typeof fsLayer>[1],
  cwd = "/ws/app",
  home = "/home/u",
) => Effect.runPromise(loadMemory(cwd, home).pipe(Effect.provide(fsLayer(files, opts))))

describe("loadMemory", () => {
  it("discovers .md memory in cwd's memory dir, parses frontmatter, sorts by name", async () => {
    const memory = await run({
      "/ws/app/.efferent/memory/zeta.md": memoryFile("Zeta decision", "last alphabetically"),
      "/ws/app/.efferent/memory/alpha.md": memoryFile("Alpha decision", "first alphabetically"),
    })
    expect(memory.map((m) => m.name)).toEqual(["alpha", "zeta"])
    expect(memory[0]).toEqual({
      name: "alpha",
      title: "Alpha decision",
      summary: "first alphabetically",
      sourcePath: "/ws/app/.efferent/memory/alpha.md",
    })
  })

  it("name is the filename slug; title/summary fall back when frontmatter is absent", async () => {
    const memory = await run({
      // No frontmatter at all — still a valid memory (a hand-written note).
      "/ws/app/.efferent/memory/raw-note.md": "just a body, no fence",
      // Frontmatter present but partial — only title.
      "/ws/app/.efferent/memory/titled.md": "---\ntitle: Just a title\n---\nbody",
    })
    expect(memory.map((m) => [m.name, m.title, m.summary])).toEqual([
      ["raw-note", "raw-note", ""],
      ["titled", "Just a title", ""],
    ])
  })

  it("closer-to-cwd shadows farther on name collisions; home is searched last", async () => {
    const memory = await run({
      "/ws/app/.efferent/memory/conv.md": memoryFile("Conventions", "from cwd"),
      "/ws/.efferent/memory/conv.md": memoryFile("Conventions", "from parent"),
      "/home/u/.efferent/memory/conv.md": memoryFile("Conventions", "from home"),
      "/home/u/.efferent/memory/extra.md": memoryFile("Home only", "unique to home"),
    })
    expect(memory.map((m) => [m.name, m.summary])).toEqual([
      ["conv", "from cwd"],
      ["extra", "unique to home"],
    ])
  })

  it("skips non-md and unreadable files without failing", async () => {
    const memory = await run(
      {
        "/ws/app/.efferent/memory/good.md": memoryFile("Good", "valid"),
        "/ws/app/.efferent/memory/notes.txt": memoryFile("Texty", "wrong extension"),
        "/ws/app/.efferent/memory/locked.md": memoryFile("Locked", "cannot be read"),
      },
      { unreadable: ["/ws/app/.efferent/memory/locked.md"] },
    )
    expect(memory.map((m) => m.name)).toEqual(["good"])
  })

  it("strips quotes, ignores comments and unknown keys, keeps colons inside values", async () => {
    const content =
      `---\n# a comment line\ntitle: "Quoted title"\nsummary: usage: run it twice\nextra: ignored\n---\nbody`
    const memory = await run({ "/ws/app/.efferent/memory/q.md": content })
    expect(memory).toEqual([
      {
        name: "q",
        title: "Quoted title",
        summary: "usage: run it twice",
        sourcePath: "/ws/app/.efferent/memory/q.md",
      },
    ])
  })

  it("resolves relative listing entries against the memory dir", async () => {
    const memory = await run(
      { "/ws/app/.efferent/memory/rel.md": memoryFile("Rel", "listed relatively") },
      { relativePaths: true },
    )
    expect(memory[0]?.sourcePath).toBe("/ws/app/.efferent/memory/rel.md")
  })

  it("no memory dirs anywhere → empty, never a failure", async () => {
    expect(await run({})).toEqual([])
  })

  it("property: total on arbitrary file content — never throws, always an array", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 300 }), fc.fullUnicodeString({ maxLength: 300 })),
        (content) => {
          const memory = Effect.runSync(
            loadMemory("/ws/app", "/home/u").pipe(
              Effect.provide(fsLayer({ "/ws/app/.efferent/memory/fuzz.md": content })),
            ),
          )
          expect(Array.isArray(memory)).toBe(true)
          for (const m of memory) {
            expect(typeof m.name).toBe("string")
            expect(typeof m.title).toBe("string")
            expect(typeof m.summary).toBe("string")
          }
        },
      ),
      { numRuns: 200 },
    )
  })
})
