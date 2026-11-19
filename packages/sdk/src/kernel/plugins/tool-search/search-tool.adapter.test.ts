import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Tool } from "effect/ai"
import { kernel, Sessions, userMessage } from "@xandreed/core/kernel"
import type { Message } from "@xandreed/core/kernel"
import { callTool, filesSearch, inMemoryFiles, inProcessJournal, sessions } from "../../index.js"
import { SearchFiles, searchHandlers, searchTools } from "./search-tool.adapter.js"

/** One turn that makes each call in order over a workspace in memory: what each call stored. */
const calls = (made: ReadonlyArray<unknown>, files: Readonly<Record<string, string>>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const all = yield* Sessions
    const session = yield* all.open(yield* all.create({ owner: "test" }))
    yield* session.append(userMessage("go"))
    const toolkit = yield* searchTools
    return yield* Effect.forEach(made, (params, index) =>
      Effect.map(callTool(toolkit, { id: `c${index}`, name: "searchFiles", params }, session), (record) => resultOf(record.message)), { concurrency: 1 })
  }).pipe(Effect.provide(Layer.mergeAll(searchHandlers, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))).pipe(
    Layer.provideMerge(filesSearch), Layer.provideMerge(inMemoryFiles(files)),
  )))))

const resultOf = (message: Message | undefined) => (message?._tag === "ToolResult" ? [message.result, message.isFailure] : message)

describe("searchFiles", () => {
  test("says what it finds, how a long line is shown, its limit and what it skips, in fixed words", () => {
    expect(SearchFiles.name).toBe("searchFiles")
    expect(SearchFiles.description).toBe(
      "Find a text in the files of the workspace, or of one folder. Returns `matches`, each a line that holds it: its `path`, its `line` number, the `column` the text starts at and the line's `text` (a line longer than 200 characters is shown as 200 of them, from 40 before the match), by path and then line; at most 50, and `more` is true when there were more: give a folder or a glob to see them. `skipped` counts the files that could not be read as text.",
    )
    expect(Tool.getJsonSchema(SearchFiles)).toEqual({
      type: "object",
      properties: {
        pattern: { type: "string", description: "The text to find, on one line, as it is written; with regex, a JavaScript regular expression." },
        regex: { type: "boolean", description: "True to read the pattern as a JavaScript regular expression, such as ^export (const|function). Left out, the text as it is written." },
        folder: { type: "string", description: "A folder in the workspace to search, such as src. Left out, the whole workspace." },
        glob: { type: "string", description: "Only files that match it: by name with no /, such as *.ts, or by path with one, such as src/**/*.ts; * and ? within a name, ** across folders." },
      },
      required: ["pattern"],
      additionalProperties: true,
    })
  })

  test("finds lines in order, in a folder and by a glob, and stops at 50 with more", async () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`many/${String(index).padStart(2, "0")}.txt`, "hit\n"]))
    const stored = await calls(
      [{ pattern: "export const", folder: "./src" }, { pattern: "^export (const|function)", regex: true, glob: "*.ts" }, { pattern: "hit" }],
      { "src/a.ts": "export const a = 1\nexport function b() {}\n", "src/b.md": "export const in prose\n", "lib/c.ts": "export const c = 2\n", ...many },
    )
    expect(stored[0]).toEqual([{ matches: [{ path: "src/a.ts", line: 1, column: 1, text: "export const a = 1" }, { path: "src/b.md", line: 1, column: 1, text: "export const in prose" }], more: false, skipped: 0 }, false])
    expect(stored[1]).toEqual([{
      matches: [{ path: "lib/c.ts", line: 1, column: 1, text: "export const c = 2" }, { path: "src/a.ts", line: 1, column: 1, text: "export const a = 1" }, { path: "src/a.ts", line: 2, column: 1, text: "export function b() {}" }],
      more: false,
      skipped: 0,
    }, false])
    expect(stored[2]).toMatchObject([{ more: true, skipped: 0 }, false])
    expect((stored[2] as [{ readonly matches: ReadonlyArray<{ readonly path: string }> }, boolean])[0].matches.map((match) => match.path)).toEqual(Object.keys(many).slice(0, 50))
  })

  test("a pattern, a glob or a folder it cannot use is a failed result in fixed words", async () => {
    const stored = await calls([
      { pattern: "" },
      { pattern: "one\ntwo" },
      { pattern: "x".repeat(1001) },
      { pattern: "(unclosed", regex: true },
      { pattern: "(\\w+\\s?)*$", regex: true },
      { pattern: "x", glob: "*".repeat(1001) },
      { pattern: "x", folder: "../up" },
    ], { "a.txt": "x" })
    expect(stored).toEqual([
      ["The pattern is empty: give the text to find.", true],
      ["The pattern \"one\\ntwo\" holds a line break, and a search matches one line at a time: search for one line of it.", true],
      ["The pattern is 1001 characters long, and a search takes at most 1000: search for a shorter part of it.", true],
      ["The pattern \"(unclosed\" is not a JavaScript regular expression. Fix it, or call searchFiles with regex left out to find the text as it is written.", true],
      ["The pattern \"(\\\\w+\\\\s?)*$\" repeats a group that itself repeats (as in (a+)+), which can take exponential time on some lines: write it without the nested repetition.", true],
      ["The glob is 1001 characters long, and a search takes at most 1000: give a shorter one, such as *.ts or src/**.", true],
      ["The path \"../up\" is not a path in the workspace. Give a path relative to the workspace, with / between folders and no \"..\", such as notes/todo.md.", true],
    ])
  })
})
