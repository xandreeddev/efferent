import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Shell, ShellError, type ShellExecInput, type ShellExecResult } from "@xandreed/sdk-core"
import { buildStalenessBrief, getWorkspaceRef, stalenessNote } from "./staleness.js"

/** A canned Shell: maps a command prefix to its stdout (exit 0); else exit 1. */
const stubShell = (answers: Record<string, string>) =>
  Shell.of({
    exec: (input: ShellExecInput) => {
      const hit = Object.entries(answers).find(([prefix]) => input.command.startsWith(prefix))
      const res: ShellExecResult = {
        exitCode: hit !== undefined ? 0 : 1,
        stdout: hit !== undefined ? hit[1] : "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
      }
      return Effect.succeed(res)
    },
  })

const failingShell = Shell.of({
  exec: () => Effect.fail(new ShellError({ cause: "boom", message: "no git here" })),
})

const run = <A>(e: Effect.Effect<A, never, Shell>, shell: Shell["Type"]) =>
  Effect.runPromise(e.pipe(Effect.provideService(Shell, shell)))

describe("staleness", () => {
  test("getWorkspaceRef returns HEAD, undefined outside a repo, undefined on shell failure", async () => {
    const head = "a".repeat(40)
    expect(await run(getWorkspaceRef("/w"), stubShell({ "git rev-parse": `${head}\n` }))).toBe(head)
    expect(await run(getWorkspaceRef("/w"), stubShell({}))).toBeUndefined()
    expect(await run(getWorkspaceRef("/w"), failingShell)).toBeUndefined()
  })

  test("stalenessNote carries the ref range, the folder diff, and the re-read instruction", () => {
    const note = stalenessNote({
      oldRef: "aaaaaaaa1111",
      newRef: "bbbbbbbb2222",
      folder: "/w/packages/core",
      diffStat: " src/x.ts | 4 ++--\n 1 file changed",
    })
    expect(note).toContain("aaaaaaa..bbbbbbb")
    expect(note).toContain("src/x.ts")
    expect(note).toContain("re-read anything you intend to edit")
  })

  test("stalenessNote without a diff still warns (repo moved, folder untouched)", () => {
    const note = stalenessNote({ oldRef: "a".repeat(12), newRef: "b".repeat(12), folder: "/w/pkg" })
    expect(note).toContain("no changes under /w/pkg")
    expect(note).toContain("re-read")
  })

  test("buildStalenessBrief: undefined when unstamped, same ref, or not a git repo", async () => {
    const head = "c".repeat(40)
    const inRepo = stubShell({ "git rev-parse": head })
    expect(
      await run(buildStalenessBrief({ workspaceDir: "/w", nodeFolder: "/w/p", stampedRef: undefined }), inRepo),
    ).toBeUndefined()
    expect(
      await run(buildStalenessBrief({ workspaceDir: "/w", nodeFolder: "/w/p", stampedRef: head }), inRepo),
    ).toBeUndefined()
    expect(
      await run(buildStalenessBrief({ workspaceDir: "/w", nodeFolder: "/w/p", stampedRef: "old" }), stubShell({})),
    ).toBeUndefined()
  })

  test("buildStalenessBrief: a moved HEAD yields the note with the folder's diff --stat", async () => {
    const shell = stubShell({
      "git rev-parse": "d".repeat(40),
      "git diff --stat": " p/file.ts | 2 +-\n 1 file changed",
    })
    const brief = await run(
      buildStalenessBrief({ workspaceDir: "/w", nodeFolder: "/w/p", stampedRef: "e".repeat(40) }),
      shell,
    )
    expect(brief).toContain("workspace changed since this context last ran")
    expect(brief).toContain("p/file.ts")
  })
})
