import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { STORED_FORMAT } from "@xandreed/core"
import { FILES_LAYOUT } from "../packages/plugin-session-files/src/session-files.entity.js"
import { SCHEMA_VERSION } from "../packages/plugin-session-sqlite/src/session-log.adapter.js"
import { MAX_SSE_LINE_CHARS, MAX_TOOL_ARGUMENT_CHARS, MAX_TOOL_CALLS } from "../packages/plugin-models/src/llm/sse.js"

/*
 * The guides name the one stored format, file layout and SQLite schema this
 * release accepts. Those numbers are written out in prose, so a bump of
 * `STORED_FORMAT`, `FILES_LAYOUT` or the SQLite `SCHEMA_VERSION` fails here
 * until every page states the new one. The error-code reference describes
 * the refusal as the code makes it: every other version, reads included.
 * The providers page states the bounds of an OpenAI-compatible stream with
 * the numbers `src/llm/sse.ts` enforces.
 */

const root = join(import.meta.dir, "..")
const read = (path: string) => readFile(join(root, path), "utf8")
const website = (page: string) => `packages/website/src/content/docs/${page}`

/** Each page and the sentences it must hold, written with the current numbers. */
const statements: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["docs/framework.md", [
    `Sessions accepts only stored format ${STORED_FORMAT} for reads and writes`,
    `Creation stamps stored format ${STORED_FORMAT}.`,
    `only schema ${SCHEMA_VERSION} is supported`,
    `Only file layout ${FILES_LAYOUT} is supported`,
    `file layout ${FILES_LAYOUT} or SQLite schema ${SCHEMA_VERSION}`,
  ]],
  [website("plugins/session-files.md"), [`Only layout ${FILES_LAYOUT} is supported`]],
  [website("plugins/session-files-log.md"), [`Only layout ${FILES_LAYOUT} is supported`]],
  [website("plugins/session-sqlite.md"), [`Opening accepts schema ${SCHEMA_VERSION}`]],
  [website("plugins/session-sqlite-log.md"), [`Opening accepts schema ${SCHEMA_VERSION}`]],
]

describe("the session store versions in the guides", () => {
  for (const [path, sentences] of statements) {
    test(`${path} states the stored format, file layout and schema this release supports`, async () => {
      const text = (await read(path)).replace(/\s+/g, " ")
      for (const sentence of sentences) expect(text).toContain(sentence)
    })
  }

  test("the error-code reference says every other version is refused, reads included, and a fresh store is the remedy", async () => {
    const reference = await read("docs/event-reference.md")
    const row = (code: string) => reference.split("\n").find((line) => line.startsWith(`| \`${code}\` |`)) ?? ""
    const format = row("session.version")
    const store = row("store.version")
    expect(format).toContain("`STORED_FORMAT`")
    expect(format).toContain("older, newer or absent")
    expect(format).toContain("`get`, `list`, `read`")
    expect(format).toContain("configure a fresh store")
    expect(format).not.toContain("still read")
    expect(store).toContain("older or newer")
    expect(store).toContain("nonempty")
    expect(store).toContain("configure a fresh store")
    expect(store).not.toContain("still opens")
  })
})

test("the providers page states the bounds an OpenAI-compatible stream is held to", async () => {
  const page = (await read(website("concepts/providers.md"))).replace(/\s+/g, " ")
  const grouped = (value: number) => value.toLocaleString("en-US")
  expect(page).toContain(`at most ${MAX_TOOL_CALLS} tool calls`)
  expect(page).toContain(`at most ${grouped(MAX_TOOL_ARGUMENT_CHARS)} characters (UTF-16 code units)`)
  expect(page).toContain(`at most ${grouped(MAX_SSE_LINE_CHARS)} characters`)
  expect(page).toContain("`model.invalid-response`")
})
