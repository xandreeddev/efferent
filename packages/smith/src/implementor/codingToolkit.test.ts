import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { LocalFileSystemLive, LocalShellLive } from "@xandreed/providers"
import { makeSmithCodingHandlers } from "./codingToolkit.js"

const withHandlers = <A>(
  cwd: string,
  run: (
    handlers: Effect.Effect.Success<ReturnType<typeof makeSmithCodingHandlers>>,
  ) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    makeSmithCodingHandlers(cwd)
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
