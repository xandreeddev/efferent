import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import type { Scope } from "../entities/Scope.js"
import { FileNotFound, FileSystem } from "../ports/FileSystem.js"
import { discoverScopeTree, getScopePromptBody } from "./discoverScopeTree.js"

/** In-memory FileSystem; `list` honors `recursive` (the mode this module uses). */
const fsLayer = (files: Record<string, string>, opts?: { relativePaths?: boolean }) =>
  Layer.succeed(
    FileSystem,
    FileSystem.of({
      read: (path: string) => {
        const content = files[path]
        return content !== undefined
          ? Effect.succeed({ content, truncated: false, totalLines: content.split("\n").length })
          : Effect.fail(new FileNotFound({ path }))
      },
      list: (dir: string, o?: { recursive?: boolean }) => {
        const prefix = dir.endsWith("/") ? dir : `${dir}/`
        const entries = Object.keys(files)
          .filter(
            (p) =>
              p.startsWith(prefix) &&
              (o?.recursive === true || !p.slice(prefix.length).includes("/")),
          )
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

const scopeFile = (name: string, description: string, body = ""): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`

/** Spy root-prompt builder: encodes what it received. */
const makeRootPrompt = (children: ReadonlyArray<Scope>, body: string | undefined): string =>
  `ROOT[${children.map((c) => c.name).join(",")}]:${body ?? "none"}`

const discover = (files: Record<string, string>, opts?: { relativePaths?: boolean }) =>
  Effect.runPromise(
    discoverScopeTree("/ws", makeRootPrompt).pipe(Effect.provide(fsLayer(files, opts))),
  )

describe("discoverScopeTree", () => {
  it("an empty (or unlistable) workspace yields a bare root and never fails", async () => {
    const root = await discover({})
    expect(root.name).toBe("root")
    expect(root.isRoot).toBe(true)
    expect(root.enforceWrite).toBe(false)
    expect(root.rootDir).toBe("/ws")
    expect(root.children).toEqual([])
    expect(root.systemPrompt).toBe("ROOT[]:none")
  })

  it("a root SCOPE.md seeds the root prompt body (frontmatter stripped) without becoming a child", async () => {
    const root = await discover({
      "/ws/SCOPE.md": scopeFile("ignored", "ignored", "house rules here"),
    })
    expect(root.children).toEqual([])
    expect(root.systemPrompt).toBe("ROOT[]:house rules here")
  })

  it("a fence-less root SCOPE.md contributes its whole content", async () => {
    const root = await discover({ "/ws/SCOPE.md": "plain instructions, no frontmatter" })
    expect(root.systemPrompt).toBe("ROOT[]:plain instructions, no frontmatter")
  })

  it("child SCOPE.md files become name-sorted children scoped to their directory", async () => {
    const root = await discover({
      "/ws/pkg/zeta/SCOPE.md": scopeFile("zeta", "the z package", "z context"),
      "/ws/pkg/alpha/SCOPE.md": scopeFile("alpha", "the a package"),
    })
    expect(root.children.map((c) => c.name)).toEqual(["alpha", "zeta"])
    expect(root.systemPrompt).toBe("ROOT[alpha,zeta]:none")
    const zeta = root.children[1]!
    expect(zeta).toMatchObject({
      description: "the z package",
      rootDir: "/ws/pkg/zeta",
      displayRoot: "/ws",
      isRoot: false,
      enforceWrite: true,
      children: [],
    })
    // The rendered scope prompt names the writeable scope and carries the body.
    expect(zeta.systemPrompt).toContain("/ws/pkg/zeta")
    expect(zeta.systemPrompt).toContain("z context")
  })

  it("nests a scope under its nearest enclosing scope, not the root", async () => {
    const root = await discover({
      "/ws/outer/SCOPE.md": scopeFile("outer", "encloses"),
      "/ws/outer/inner/SCOPE.md": scopeFile("inner", "enclosed"),
    })
    expect(root.children.map((c) => c.name)).toEqual(["outer"])
    expect(root.children[0]!.children.map((c) => c.name)).toEqual(["inner"])
    expect(root.children[0]!.children[0]!.rootDir).toBe("/ws/outer/inner")
  })

  it("skips duplicate names and malformed files", async () => {
    const root = await discover({
      "/ws/a/SCOPE.md": scopeFile("dup", "first wins"),
      "/ws/b/SCOPE.md": scopeFile("dup", "second skipped"),
      "/ws/c/SCOPE.md": "no frontmatter at all",
      "/ws/d/SCOPE.md": "---\nname: only-name\n---\nbody",
    })
    expect(root.children.map((c) => [c.name, c.description])).toEqual([["dup", "first wins"]])
  })

  it("resolves relative listing entries against the workspace root", async () => {
    const root = await discover(
      { "/ws/rel/SCOPE.md": scopeFile("rel", "relatively listed") },
      { relativePaths: true },
    )
    expect(root.children.map((c) => c.rootDir)).toEqual(["/ws/rel"])
  })
})

describe("getScopePromptBody", () => {
  const body = (files: Record<string, string>, folder = "/ws/pkg") =>
    Effect.runPromise(getScopePromptBody(folder).pipe(Effect.provide(fsLayer(files))))

  it("returns the body with frontmatter stripped", async () => {
    expect(
      await body({ "/ws/pkg/SCOPE.md": scopeFile("x", "y", "ambient folder context") }),
    ).toBe("ambient folder context")
  })

  it("a fence-less SCOPE.md returns its whole content", async () => {
    expect(await body({ "/ws/pkg/SCOPE.md": "raw context, no fence" })).toBe(
      "raw context, no fence",
    )
  })

  it("blank body and missing file both yield undefined", async () => {
    expect(await body({ "/ws/pkg/SCOPE.md": scopeFile("x", "y", "   \n") })).toBeUndefined()
    expect(await body({})).toBeUndefined()
  })
})
