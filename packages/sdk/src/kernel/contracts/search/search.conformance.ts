import { Array as Arr, Effect, Order, Result } from "effect"
import type { Context, Scope } from "effect"
import type { ConformanceCheck, ConformanceFailure } from "@xandreed/core/kernel"
import { expect, refuses, show, unexpected } from "../conformance.entity.functions.js"
import type { FilePath } from "../files/files.entity.js"
import { workspacePath } from "../files/files.entity.functions.js"
import type { SearchQuery } from "./search.entity.js"
import type { Search } from "./search.port.js"

type SearchShape = Context.Service.Shape<typeof Search>

/**
 * A search as the kit opens it: over a fresh workspace holding exactly the files given (path to text), released with
 * its scope.
 *
 * @public
 */
export interface SearchSubject {
  readonly open: (files: Readonly<Record<string, string>>) => Effect.Effect<SearchShape, never, Scope.Scope>
}

const at = (text: string): FilePath => Result.getOrThrowWith(workspacePath(text), (problem) => new Error(problem))

/** How a check reads what was found: each match as `path:line`, or with `full` as `path:line:column:text`; with `ordered`, in the order given. */
interface Reading {
  readonly more?: boolean
  readonly full?: boolean
  readonly ordered?: boolean
}

/**
 * Whether `query` finds `want` and says `more` as `reading` asks. Only the checks of order compare the order, and only
 * the check of a line compares columns and text, so a search careless about one fails that check alone.
 */
const finds = (check: string, search: SearchShape, query: SearchQuery, want: ReadonlyArray<string>, reading: Reading = {}) =>
  Effect.flatMap(search.find(query).pipe(unexpected(check)), (found) => {
    const read = found.matches.map((match) => reading.full === true ? `${match.path}:${match.line}:${match.column}:${match.text}` : `${match.path}:${match.line}`)
    const [got, wanted] = reading.ordered === true ? [read, want] : [Arr.sort(read, Order.String), Arr.sort(want, Order.String)]
    return Effect.andThen(
      expect(check, show(got) === show(wanted), `${show(query)} found ${show(read)}, not ${show(want)}`),
      expect(check, found.more === (reading.more ?? false), `${show(query)} said more is ${found.more}, not ${reading.more ?? false}`),
    )
  })

const long = `${"a".repeat(300)}needle${"b".repeat(300)}`
const tailed = `${"x".repeat(400)}tail`

const checks: ReadonlyArray<readonly [string, string, Readonly<Record<string, string>>, (search: SearchShape) => Effect.Effect<void, ConformanceFailure>]> = [
  ["literal", "a pattern is found as it is written, letter case counting", { "a.txt": "a.b\naxb\nA.B\nf(x)\n" }, (search) => Effect.andThen(
    finds("literal", search, { pattern: "a.b", limit: 10 }, ["a.txt:1"]),
    finds("literal", search, { pattern: "(", limit: 10 }, ["a.txt:4"]),
  )],
  ["regex", "with regex, a pattern is a JavaScript regular expression", { "a.txt": "a.b\naxb\nA.B\n" }, (search) => Effect.andThen(
    finds("regex", search, { pattern: "a.b", regex: true, limit: 10 }, ["a.txt:1", "a.txt:2"]),
    finds("regex", search, { pattern: "^x|b$", regex: true, limit: 10 }, ["a.txt:1", "a.txt:2"]),
  )],
  ["order", "matches come by path in code-unit order, then by line", { "b.txt": "x\n", "a/z.txt": "x\n\nx\n", "B.txt": "x", "a.txt": "x" }, (search) =>
    finds("order", search, { pattern: "x", limit: 10 }, ["B.txt:1", "a.txt:1", "a/z.txt:1", "a/z.txt:3", "b.txt:1"], { ordered: true })],
  ["folder", "a folder keeps the files in it and in its folders, never a name that only starts like it", { "src/a.ts": "x", "src/in/b.ts": "x", "srcx/c.ts": "x", "d.ts": "x" }, (search) =>
    finds("folder", search, { pattern: "x", folder: at("src"), limit: 10 }, ["src/a.ts:1", "src/in/b.ts:1"])],
  ["glob", "a glob with no / keeps files by name, one with a / by path, * and ? within a name and ** across folders", { "src/a.ts": "x", "src/in/b.ts": "x", "src/c.js": "x", "test/a.ts": "x", "ab.ts": "x" }, (search) => Effect.gen(function* () {
    yield* finds("glob", search, { pattern: "x", glob: "*.ts", limit: 10 }, ["ab.ts:1", "src/a.ts:1", "src/in/b.ts:1", "test/a.ts:1"])
    yield* finds("glob", search, { pattern: "x", glob: "src/*.ts", limit: 10 }, ["src/a.ts:1"])
    yield* finds("glob", search, { pattern: "x", glob: "src/**", limit: 10 }, ["src/a.ts:1", "src/c.js:1", "src/in/b.ts:1"])
    yield* finds("glob", search, { pattern: "x", glob: "**/?.ts", limit: 10 }, ["src/a.ts:1", "src/in/b.ts:1", "test/a.ts:1"])
  })],
  ["limit", "at most the limit, in order, and more says whether there were more", { "a.txt": "x\nx\nx\n", "b.txt": "x\nx\n" }, (search) => Effect.gen(function* () {
    yield* finds("limit", search, { pattern: "x", limit: 3 }, ["a.txt:1", "a.txt:2", "a.txt:3"], { more: true, ordered: true })
    yield* finds("limit", search, { pattern: "x", limit: 5 }, ["a.txt:1", "a.txt:2", "a.txt:3", "b.txt:1", "b.txt:2"], { ordered: true })
  })],
  ["line", "a match gives its line and column from 1, the line without its line end, and a long line around the match", { "a.txt": "one\r\ntwo needle\r\n", "b.txt": long, "c.txt": tailed }, (search) => Effect.gen(function* () {
    yield* finds("line", search, { pattern: "needle", limit: 10 }, ["a.txt:2:5:two needle", `b.txt:1:301:${long.slice(260, 460)}`], { full: true })
    // A match near the end of a long line: the line's last characters.
    yield* finds("line", search, { pattern: "tail", limit: 10 }, [`c.txt:1:401:${tailed.slice(204)}`], { full: true })
  })],
  ["refused", "an empty pattern, one with a line break and a regular expression that does not compile fail with PatternInvalid", { "a.txt": "x" }, (search) => Effect.gen(function* () {
    const invalid = (reason: string) => (error: { readonly _tag: string; readonly reason?: string }) => error._tag === "PatternInvalid" && error.reason === reason
    yield* refuses("refused", "an empty pattern", search.find({ pattern: "", limit: 10 }), invalid("Empty"))
    yield* refuses("refused", "a pattern with a line break", search.find({ pattern: "a\nb", limit: 10 }), invalid("LineBreak"))
    yield* refuses("refused", "a regular expression that does not compile", search.find({ pattern: "(", regex: true, limit: 10 }), invalid("NotRegex"))
  })],
  ["none", "a pattern no line holds finds nothing, and no more", { "a.txt": "x\ny\n" }, (search) =>
    finds("none", search, { pattern: "z", limit: 10 }, [])],
]

/**
 * The `Search` contract as checks (ADR 0028), each over a workspace of its own: a pattern is found as written, letter
 * case counting (`literal`); with `regex`, as a JavaScript regular expression (`regex`); matches come by path in
 * code-unit order, then by line (`order`); a folder keeps what is in it and its folders (`folder`); a glob keeps files
 * by name, or by path when it holds a `/` (`glob`); at most the limit, with `more` (`limit`); a match's line and column
 * from 1, its text without the line end and a long line shown around the match (`line`); a pattern the search cannot
 * use fails with `PatternInvalid` (`refused`); and nothing found is no match and no more (`none`).
 *
 * @public
 */
export const searchConformance = (subject: SearchSubject): ReadonlyArray<ConformanceCheck> =>
  checks.map(([id, name, files, run]) => ({ id, name, run: Effect.scoped(Effect.flatMap(subject.open(files), run)) }))
