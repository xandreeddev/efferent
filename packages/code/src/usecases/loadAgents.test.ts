import { describe, expect, it } from "bun:test"
import { Effect, FastCheck as fc, Layer } from "effect"
import { FileNotFound, FileSystem } from "@xandreed/sdk-core"
import { loadAgents, parseAgentFile } from "./loadAgents.js"

/** In-memory FileSystem mirroring loadSkills.test.ts's harness. */
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

const run = (
  files: Record<string, string>,
  opts?: Parameters<typeof fsLayer>[1],
  cwd = "/ws/app",
  home = "/home/u",
) => Effect.runPromise(loadAgents(cwd, home).pipe(Effect.provide(fsLayer(files, opts))))

describe("loadAgents", () => {
  it("parses name/description + optional role and a comma/space tools allowlist", async () => {
    const agents = await run({
      "/ws/app/.efferent/agents/reviewer.md": `---
name: reviewer
description: reviews diffs
role: code
tools: read_file, grep ls
---
You review code.`,
    })
    expect(agents).toEqual([
      {
        name: "reviewer",
        description: "reviews diffs",
        role: "code",
        tools: ["read_file", "grep", "ls"],
        body: "You review code.",
        sourcePath: "/ws/app/.efferent/agents/reviewer.md",
      },
    ])
  })

  it("ignores an unknown role value and never reads a model: field (the footgun)", async () => {
    const agents = await run({
      "/ws/app/.efferent/agents/r.md": `---
name: r
description: d
role: wizard
model: anthropic:claude-opus-4-8
---
b`,
    })
    expect(agents[0]?.role).toBeUndefined()
    expect((agents[0] as { model?: string })?.model).toBeUndefined()
  })

  it("omits role/tools when absent (no nullable noise — just not present)", async () => {
    const agents = await run({
      "/ws/app/.efferent/agents/plain.md": `---
name: plain
description: a generic role
---
body`,
    })
    expect(agents[0]).toEqual({
      name: "plain",
      description: "a generic role",
      body: "body",
      sourcePath: "/ws/app/.efferent/agents/plain.md",
    })
    expect(agents[0]?.role).toBeUndefined()
    expect(agents[0]?.tools).toBeUndefined()
  })

  it("closer-to-cwd shadows farther on name collisions; home is searched last", async () => {
    const agents = await run({
      "/ws/app/.efferent/agents/r.md": "---\nname: r\ndescription: from cwd\n---\nb",
      "/ws/.efferent/agents/r.md": "---\nname: r\ndescription: from parent\n---\nb",
      "/home/u/.efferent/agents/r.md": "---\nname: r\ndescription: from home\n---\nb",
      "/home/u/.efferent/agents/h.md": "---\nname: homer\ndescription: home only\n---\nb",
    })
    expect(agents.map((a) => [a.name, a.description])).toEqual([
      ["homer", "home only"],
      ["r", "from cwd"],
    ])
  })

  it("skips malformed / missing-required / non-md without failing", async () => {
    const agents = await run({
      "/ws/app/.efferent/agents/good.md": "---\nname: good\ndescription: ok\n---\nb",
      "/ws/app/.efferent/agents/no-fence.md": "no frontmatter here",
      "/ws/app/.efferent/agents/no-desc.md": "---\nname: x\n---\nb",
      "/ws/app/.efferent/agents/notes.txt": "---\nname: texty\ndescription: wrong ext\n---\nb",
    })
    expect(agents.map((a) => a.name)).toEqual(["good"])
  })

  it("parseAgentFile validates frontmatter for the git-import path", () => {
    expect(parseAgentFile("---\nname: a\ndescription: d\n---\nbody", "/x.md")?.name).toBe("a")
    expect(parseAgentFile("no frontmatter", "/x.md")).toBeUndefined()
    expect(parseAgentFile("---\nname: a\n---\nbody", "/x.md")).toBeUndefined()
  })

  it("property: arbitrary content never throws, always a well-typed array", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (content) => {
        const agents = Effect.runSync(
          loadAgents("/ws/app", "/home/u").pipe(
            Effect.provide(fsLayer({ "/ws/app/.efferent/agents/fuzz.md": content })),
          ),
        )
        expect(Array.isArray(agents)).toBe(true)
        for (const a of agents) {
          expect(typeof a.name).toBe("string")
          expect(typeof a.description).toBe("string")
          if (a.tools !== undefined) expect(Array.isArray(a.tools)).toBe(true)
        }
      }),
      { numRuns: 200 },
    )
  })
})
