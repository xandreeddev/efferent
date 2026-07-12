import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
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
  test("write_file/edit_file refuse harness state — the trail is not the coder's to modify", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-kit-"))
    await withHandlers(cwd, (h) =>
      Effect.gen(function* () {
        const db = yield* h
          .write_file({ path: ".efferent/smith.db", content: "gone" })
          .pipe(Effect.either)
        expect(db._tag).toBe("Left")
        expect(JSON.stringify(db)).toContain("harness state")
        const artifact = yield* h
          .write_file({ path: ".foundry/runs/x.json", content: "{}" })
          .pipe(Effect.either)
        expect(artifact._tag).toBe("Left")
        const edit = yield* h
          .edit_file({ path: ".efferent/memory/ledger.jsonl", oldText: "a", newText: "b" })
          .pipe(Effect.either)
        expect(edit._tag).toBe("Left")
        // A sibling that merely SHARES the prefix is untouched.
        const ok = yield* h.write_file({ path: ".efferent-notes.md", content: "fine" })
        expect(ok.written).toBe(true)
      }),
    )
  })

  test("read_file refuses every path outside the workspace", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-kit-"))
    await withHandlers(cwd, (h) =>
      Effect.gen(function* () {
        const denied = yield* h
          .read_file({ path: `${process.env.HOME}/.efferent/auth.json` })
          .pipe(Effect.either)
        expect(denied._tag).toBe("Left")
        expect(JSON.stringify(denied)).toContain("OutsideWorkspace")
        // A relative dodge resolves to the same file and is equally refused.
        const dodged = yield* h
          .read_file({ path: "../../../../../../../..//" + `${process.env.HOME}/.efferent/auth.json`.slice(1) })
          .pipe(Effect.either)
        expect(dodged._tag).toBe("Left")
      }),
    )
  })

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

  test("reads and writes outside the workspace are refused", async () => {
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

        const read = yield* h.read_file({ path: join(outside, "secret.txt") }).pipe(Effect.either)
        expect(read._tag).toBe("Left")
        expect(JSON.stringify(read)).toContain("OutsideWorkspace")
      }),
    )
  })

  test("canonical guards reject symlinks that escape the workspace", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-kit-"))
    const outside = mkdtempSync(join(tmpdir(), "smith-outside-"))
    writeFileSync(join(outside, "secret.txt"), "do not expose")
    symlinkSync(outside, join(cwd, "escape"), "dir")
    await withHandlers(cwd, (h) =>
      Effect.gen(function* () {
        const read = yield* h.read_file({ path: "escape/secret.txt" }).pipe(Effect.either)
        expect(read._tag).toBe("Left")

        const write = yield* h
          .write_file({ path: "escape/overwrite.txt", content: "escaped" })
          .pipe(Effect.either)
        expect(write._tag).toBe("Left")
        expect(JSON.stringify(write)).toContain("OutsideWorkspace")
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
