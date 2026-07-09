import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { SpecDoc } from "@xandreed/engine"
import { LocalFileSystemLive, LocalShellLive } from "@xandreed/providers"
import { gitMutation, makeSmithCodingHandlers, specAllowsGitMutation } from "./codingToolkit.js"

const withHandlers = <A>(
  cwd: string,
  run: (
    handlers: Effect.Effect.Success<ReturnType<typeof makeSmithCodingHandlers>>,
  ) => Effect.Effect<A, unknown>,
  git: { readonly allowMutation: boolean } = { allowMutation: false },
): Promise<A> =>
  Effect.runPromise(
    makeSmithCodingHandlers(cwd, git)
      .pipe(
        Effect.flatMap(run),
        Effect.provide(LocalFileSystemLive),
        Effect.provide(LocalShellLive),
      ) as Effect.Effect<A>,
  )

describe("the smith coding handlers — the direct coder's hands", () => {
  test("edit_file: exact single match applies; ambiguity and misses bounce with guidance", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-kit-"))
    writeFileSync(join(cwd, "a.ts"), "const x = 1\nconst y = 1\n")
    await withHandlers(cwd, (h) =>
      Effect.gen(function* () {
        // Ambiguous ("= 1" appears twice) → bounced, file untouched.
        const ambiguous = yield* h
          .edit_file({ path: "a.ts", oldText: "= 1", newText: "= 2" })
          .pipe(Effect.either)
        expect(ambiguous._tag).toBe("Left")
        expect(JSON.stringify(ambiguous)).toContain("2 times")

        // Miss → bounced with the re-read hint.
        const miss = yield* h
          .edit_file({ path: "a.ts", oldText: "const z = 9", newText: "" })
          .pipe(Effect.either)
        expect(miss._tag).toBe("Left")
        expect(JSON.stringify(miss)).toContain("not found")

        // Unique → applied (the flat single-edit shape).
        const ok = yield* h.edit_file({
          path: "a.ts",
          oldText: "const x = 1",
          newText: "const x = 42",
        })
        expect(ok.applied).toBe(1)
        expect(readFileSync(join(cwd, "a.ts"), "utf-8")).toContain("const x = 42")
      }),
    )
  })

  test("writes outside the workspace are refused; reads are allowed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-kit-"))
    const outside = mkdtempSync(join(tmpdir(), "smith-outside-"))
    writeFileSync(join(outside, "secret.txt"), "readable")
    await withHandlers(cwd, (h) =>
      Effect.gen(function* () {
        const refused = yield* h
          .write_file({ path: join(outside, "evil.txt"), content: "x" })
          .pipe(Effect.either)
        expect(refused._tag).toBe("Left")
        expect(JSON.stringify(refused)).toContain("OutsideWorkspace")

        const read = yield* h.read_file({ path: join(outside, "secret.txt") })
        expect(read.content).toBe("readable")
      }),
    )
  })

  test("an EMPTY write is refused as data — the long-context collapse guard", async () => {
    // The degenerate-loop signature: write_file(path, "") repeated at 110k
    // context. The refusal gives the model a corrective instead of a
    // no-progress success.
    const cwd = mkdtempSync(join(tmpdir(), "smith-kit-"))
    await withHandlers(cwd, (h) =>
      Effect.gen(function* () {
        const refused = yield* h
          .write_file({ path: "src/empty.ts", content: "" })
          .pipe(Effect.either)
        expect(refused._tag).toBe("Left")
        expect(JSON.stringify(refused)).toContain("EmptyContent")
      }),
    )
  })

  test("Bash runs in the workspace; a non-zero exit is a RESULT, not an error", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-kit-"))
    await withHandlers(cwd, (h) =>
      Effect.gen(function* () {
        const pwd = yield* h.Bash({ command: "pwd" })
        expect(pwd.stdout.trim()).toBe(cwd)
        const fail = yield* h.Bash({ command: "exit 3" })
        expect(fail.exitCode).toBe(3)
      }),
    )
  })

  test("gitMutation: mutating subcommands are named, read-only git and non-git pass", () => {
    // The live incident: the coder ran plain `git add`, staged the whole
    // port, and the user's `git diff` showed nothing — the work looked lost.
    expect(gitMutation("git add .")).toEqual(Option.some("add"))
    expect(gitMutation("git status && git commit -m 'wip'")).toEqual(Option.some("commit"))
    expect(gitMutation("git -C sub -c user.email=x rebase main")).toEqual(Option.some("rebase"))
    expect(gitMutation("cd src; /usr/bin/git stash pop")).toEqual(Option.some("stash"))
    // Fail-closed: an unknown subcommand is refused too, not waved through.
    expect(gitMutation("git frobnicate")).toEqual(Option.some("frobnicate"))
    expect(gitMutation("git log --oneline | head -5")).toEqual(Option.none())
    expect(gitMutation("git diff HEAD~1 && git status")).toEqual(Option.none())
    expect(gitMutation("bun test && grep -rn addEventListener src")).toEqual(Option.none())
  })

  test("Bash refuses git mutation as failure-data; the spec constraint opts in", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-kit-"))
    await withHandlers(cwd, (h) =>
      Effect.gen(function* () {
        const refused = yield* h.Bash({ command: "git add -A" }).pipe(Effect.either)
        expect(refused._tag).toBe("Left")
        expect(JSON.stringify(refused)).toContain("GitMutationRefused")
        expect(JSON.stringify(refused)).toContain("belongs to the HUMAN")
        // Read-only git still executes (a non-repo just exits non-zero — data).
        const status = yield* h.Bash({ command: "git status" })
        expect(status.exitCode).not.toBe(0)
      }),
    )
    // The escape hatch: handlers built with allowMutation execute the command.
    await withHandlers(
      cwd,
      (h) =>
        Effect.gen(function* () {
          const ran = yield* h.Bash({ command: "git add -A" })
          expect(ran.exitCode).not.toBe(0) // not a repo — but it RAN
        }),
      { allowMutation: true },
    )
  })

  test("specAllowsGitMutation reads the constraints bullet", () => {
    const doc = (constraints: ReadonlyArray<string>) =>
      Schema.decodeUnknownSync(SpecDoc)({
        slug: "port-the-module",
        status: "locked",
        created: "2026-07-09T00:00:00Z",
        goal: "port it",
        acceptance: [],
        constraints,
        nonGoals: [],
        checks: [],
        limits: { maxAttempts: 3, budgetMinutes: 15 },
        gates: {},
      })
    expect(specAllowsGitMutation(Option.none())).toBe(false)
    expect(specAllowsGitMutation(Option.some(doc(["keep exports stable"])))).toBe(false)
    expect(
      specAllowsGitMutation(Option.some(doc(["allow-git-mutation: the task rewrites history"]))),
    ).toBe(true)
  })

  test("write_file creates parent dirs; read_file pages with offset/limit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-kit-"))
    await withHandlers(cwd, (h) =>
      Effect.gen(function* () {
        yield* h.write_file({ path: "deep/nested/f.txt", content: "l1\nl2\nl3\nl4" })
        const page = yield* h.read_file({ path: "deep/nested/f.txt", offset: 2, limit: 2 })
        expect(page.content).toBe("l2\nl3")
      }),
    )
  })
})
