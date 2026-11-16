import { Effect, Option, Result } from "effect"
import type { Context, Scope } from "effect"
import type { ConformanceCheck, ConformanceFailure } from "@xandreed/core/kernel"
import { expect, refuses, show, unexpected } from "../conformance.entity.functions.js"
import type { FilePath } from "./files.entity.js"
import { workspacePath } from "./files.entity.functions.js"
import type { Files } from "./files.port.js"

type FilesShape = Context.Service.Shape<typeof Files>

/**
 * A workspace as the kit opens it: a fresh, empty one per check, released with its scope.
 *
 * @public
 */
export interface FilesSubject {
  readonly open: Effect.Effect<FilesShape, never, Scope.Scope>
}

/** A path the kit writes, made as a model's would be. */
const at = (text: string): FilePath => Result.getOrThrowWith(workspacePath(text), (problem) => new Error(problem))

/** A text every medium must keep as it is: line ends of both kinds, spaces at both ends, a character of two halves. */
const awkward = "  first line\r\nsecond\tline\né 😀 last  \n"

const holds = (files: FilesShape, check: string, path: FilePath, text: string, what: string) =>
  Effect.flatMap(files.read(path), (read) => expect(check, read === text, `${what}: ${path} held ${show(read)}, not ${show(text)}`))

const checks: ReadonlyArray<readonly [string, string, (files: FilesShape) => Effect.Effect<void, ConformanceFailure>]> = [
  ["read-back", "a file is read back as it was written, character for character", (files) => Effect.gen(function* () {
    yield* files.write(at("notes/a.txt"), awkward)
    yield* holds(files, "read-back", at("notes/a.txt"), awkward, "a file written and read back")
    yield* files.write(at("empty.txt"), "")
    yield* holds(files, "read-back", at("empty.txt"), "", "an empty file written and read back")
  }).pipe(unexpected("read-back"))],
  ["not-found", "a path no file is at fails with FileNotFound", (files) =>
    refuses("not-found", "reading a path no file is at", files.read(at("nothing/here.txt")), (error) => error._tag === "FileNotFound")],
  ["overwrite", "a write with nothing expected replaces the file's text", (files) => Effect.gen(function* () {
    yield* files.write(at("a.txt"), "one")
    yield* files.write(at("a.txt"), "two")
    yield* holds(files, "overwrite", at("a.txt"), "two", "a file written twice")
  }).pipe(unexpected("overwrite"))],
  ["expected", "a write that expects the text the file holds, or no file where none is, writes", (files) => Effect.gen(function* () {
    yield* files.write(at("a.txt"), "one", { _tag: "Absent" })
    yield* holds(files, "expected", at("a.txt"), "one", "a file created where none was expected")
    yield* files.write(at("a.txt"), "two", { _tag: "Holds", text: "one" })
    yield* holds(files, "expected", at("a.txt"), "two", "a file written where its text was expected")
  }).pipe(unexpected("expected"))],
  ["changed", "a write that expects what the file does not hold fails with FileChanged and writes nothing", (files) => Effect.gen(function* () {
    yield* files.write(at("a.txt"), "one")
    yield* refuses("changed", "a write that expected other text", files.write(at("a.txt"), "two", { _tag: "Holds", text: "zero" }), (error) => error._tag === "FileChanged")
    yield* refuses("changed", "a write that expected no file where one is", files.write(at("a.txt"), "two", { _tag: "Absent" }), (error) => error._tag === "FileChanged")
    yield* holds(files, "changed", at("a.txt"), "one", "after two refused writes")
    yield* refuses("changed", "a write that expected text where no file is", files.write(at("b.txt"), "two", { _tag: "Holds", text: "" }), (error) => error._tag === "FileChanged")
    yield* refuses("changed", "reading the file a refused write named", files.read(at("b.txt")), (error) => error._tag === "FileNotFound")
  }).pipe(unexpected("changed"))],
  ["list", "a folder lists every file in it and the folders in it, by code unit, and never a name that only starts like it", (files) => Effect.gen(function* () {
    for (const path of ["notes/b/c.txt", "notesx", "z.txt", "notes/a.txt", "notes/Z.txt"]) yield* files.write(at(path), path)
    const all = yield* files.list(Option.none())
    yield* expect("list", show(all) === show(["notes/Z.txt", "notes/a.txt", "notes/b/c.txt", "notesx", "z.txt"]), `the whole workspace listed ${show(all)}`)
    const notes = yield* files.list(Option.some(at("notes")))
    yield* expect("list", show(notes) === show(["notes/Z.txt", "notes/a.txt", "notes/b/c.txt"]), `the folder notes listed ${show(notes)}`)
    const file = yield* files.list(Option.some(at("z.txt")))
    yield* expect("list", file.length === 0, `a file listed as a folder gave ${show(file)}`)
  }).pipe(unexpected("list"))],
]

/**
 * The `Files` contract as checks (ADR 0017), each on a fresh, empty workspace: a file is read back character for
 * character (`read-back`); a path with no file fails with `FileNotFound` (`not-found`); a write with nothing
 * expected replaces (`overwrite`); one that expects what the file holds writes (`expected`), and one that expects
 * anything else fails with `FileChanged` and writes nothing (`changed`); a folder lists what is in it and in its
 * folders, ordered by code unit, never a name that only starts like it (`list`). A workspace that declines a write
 * by a rule of its own (`FilesRefused`) is the host's: the kit writes only what every workspace takes.
 *
 * @public
 */
export const filesConformance = (subject: FilesSubject): ReadonlyArray<ConformanceCheck> =>
  checks.map(([id, name, run]) => ({ id, name, run: Effect.scoped(Effect.flatMap(subject.open, run)) }))
