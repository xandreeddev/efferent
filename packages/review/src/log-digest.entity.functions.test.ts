import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { digestLog, plainText } from "./log-digest.entity.functions.js"
import { FAILURES_KEPT } from "./log-digest.entity.js"

const TSC = [
  "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/b.ts(3,1): error TS2304: Cannot find name 'foo'.",
  "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "",
  "Found 3 errors in 2 files.",
  "",
].join("\n")

const BUN_TEST = [
  "packages/app/src/sum.test.ts:",
  "(pass) sum > adds [0.12ms]",
  "(fail) sum > fails when it should not [1.00ms]",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: 3",
  "Received: 4",
  "",
  "      at <anonymous> (/work/repo/packages/app/src/sum.test.ts:10:22)",
  "(pass) sum > reports a failure in its title [0.10ms]",
  "WARN recall failed, so words are used",
  "",
  " 2 pass",
  " 1 fail",
  "Ran 3 tests across 1 files. [20.00ms]",
].join("\n")

const ESLINT = [
  "",
  "/work/repo/src/app.ts",
  "  12:5  error  'x' is assigned a value but never used  no-unused-vars",
  "  20:1  warning  Unexpected console statement  no-console",
  "",
  "/work/repo/src/util.ts",
  "  3:10  error  'y' is assigned a value but never used  no-unused-vars",
  "",
  "\u001b[31m✖ 3 problems (2 errors, 1 warning)\u001b[39m",
].join("\n")

/** `gh run view --log-failed`: `job<TAB>step<TAB>timestamp line`, a line of a multi-line message with no timestamp. */
const CI = [
  "##[group]packages/sdk/src/guide.test.ts:",
  "2026-11-19T11:47:00.4922628Z (pass) the guide > a host follows the conversation [3.00ms]",
  "2026-11-19T11:47:00.5083413Z ##[error]  \"export class Inbox extends Context.Service<Inbox, {",
  "    readonly enqueue: (session: SessionId) => Effect.Effect<Queued>",
  "2026-11-19T11:47:00.5103592Z       at <anonymous> (/home/runner/work/efferent/efferent/packages/sdk/src/guide.test.ts:185:22)",
  "2026-11-19T11:47:00.5099192Z error: expect(received).toBe(expected)",
  "2026-11-19T11:47:00.5103592Z       at <anonymous> (/home/runner/work/efferent/efferent/packages/sdk/src/guide.test.ts:185:22)",
  "2026-11-19T11:47:00.5105226Z (fail) docs/kernel.md > quotes the inbox [2.00ms]",
  "2026-11-19T11:47:00.5205226Z       at failed (/home/runner/work/efferent/efferent/packages/core/src/core.adapter.ts:105:11)",
  "2026-11-19T11:57:39.2009457Z ##[error]  [",
  "2026-11-19T11:57:39.2009457Z error: expect(received).toEqual(expected)",
  "2026-11-19T11:57:39.2019457Z       at runLoop (/home/runner/work/efferent/efferent/node_modules/.bun/effect@4.0.7/node_modules/effect/dist/internal/effect.js:476:88)",
  "2026-11-19T11:57:39.2029457Z       at <anonymous> (/home/runner/work/efferent/efferent/packages/website/src/learn/lessons/approvals/lesson.test.ts:418:33)",
  "2026-11-19T11:48:23.2629979Z (pass) runPipeline > a rank-0 failure runs the whole rank [1.00ms]",
  "2026-11-19T11:50:41.9623129Z [11:50:41.961] WARN (#29624): recall by meaning is skipped: the embedder failed",
  "2026-11-19T11:57:39.2022694Z (fail) lesson 9 on the page > forget fails where it would ask [5.00ms]",
  "2026-11-19T12:01:32.8345834Z 2 tests failed:",
  "2026-11-19T12:01:32.8347529Z (fail) docs/kernel.md > quotes the inbox [2.00ms]",
  "2026-11-19T12:01:32.8349194Z (fail) lesson 9 on the page > forget fails where it would ask [5.00ms]",
  "2026-11-19T12:01:32.8349796Z ",
  "2026-11-19T12:01:32.8349899Z  2511 pass",
  "2026-11-19T12:01:32.8350105Z  2 fail",
  "2026-11-19T12:01:32.8350671Z Ran 2513 tests across 244 files. [912.72s]",
  "2026-11-19T12:01:32.8990816Z ##[error]Process completed with exit code 1.",
].map((line) => `ci\tRun bun test\t${line}`).join("\n")

const CI_LINES = [
  "\"export class Inbox extends Context.Service<Inbox, {",
  "  at <anonymous> (/home/runner/work/efferent/efferent/packages/sdk/src/guide.test.ts:185:22)",
  "error: expect(received).toBe(expected)",
  "  at <anonymous> (/home/runner/work/efferent/efferent/packages/sdk/src/guide.test.ts:185:22)",
  "(fail) docs/kernel.md > quotes the inbox (seen 2 times)",
  "error: expect(received).toEqual(expected)",
  "  at <anonymous> (/home/runner/work/efferent/efferent/packages/website/src/learn/lessons/approvals/lesson.test.ts:418:33)",
  "(fail) lesson 9 on the page > forget fails where it would ask (seen 2 times)",
]
const CI_SUMMARY = "2 tests failed; 2511 pass; 2 fail; Ran 2513 tests across 244 files. [912.72s]; Process completed with exit code 1."

describe("digestLog", () => {
  test("tsc: errors deduplicated with a count, the one on a changed path first, the summary line", () => {
    const digest = digestLog(TSC, ["packages/app/src/b.ts"])
    expect(digest).toEqual({
      summary: Option.some("Found 3 errors in 2 files."),
      failures: [
        { text: "src/b.ts(3,1): error TS2304: Cannot find name 'foo'.", detail: [], count: 1, onChangedPath: true },
        { text: "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.", detail: [], count: 2, onChangedPath: false },
      ],
      failuresCut: 0,
      onChangedPath: true,
      lines: [
        "src/b.ts(3,1): error TS2304: Cannot find name 'foo'.",
        "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'. (seen 2 times)",
        "Found 3 errors in 2 files.",
      ],
      linesCut: 0,
      logLines: 5,
    })
  })

  test("bun test: a failure, its error with the location after the expectation, a title with \"fail\" in it passed over", () => {
    const digest = digestLog(BUN_TEST, ["packages/app/src/sum.test.ts"])
    expect(digest.lines).toEqual([
      "error: expect(received).toBe(expected)",
      "  at <anonymous> (/work/repo/packages/app/src/sum.test.ts:10:22)",
      "(fail) sum > fails when it should not",
      "2 pass; 1 fail; Ran 3 tests across 1 files. [20.00ms]",
    ])
    expect(digest.failures.map((failure) => failure.onChangedPath)).toEqual([true, false])
  })

  test("eslint: each error under the file named above it, a warning passed over, colours read past", () => {
    const digest = digestLog(ESLINT, ["src/util.ts"])
    expect(digest.lines).toEqual([
      "/work/repo/src/util.ts:3:10 error 'y' is assigned a value but never used no-unused-vars",
      "/work/repo/src/app.ts:12:5 error 'x' is assigned a value but never used no-unused-vars",
      "✖ 3 problems (2 errors, 1 warning)",
    ])
  })

  test("a CI log: prefixes and timestamps read past, annotations and the recap folded into counts, the exit a summary; a lone [, a title's later frames and node_modules frames dropped", () => {
    const digest = digestLog(CI, ["packages/sdk/src/guide.test.ts"])
    expect(digest.lines).toEqual([...CI_LINES, CI_SUMMARY])
    expect(digest.summary).toEqual(Option.some(CI_SUMMARY))
    expect(digest.failures.map((failure) => [failure.count, failure.onChangedPath])).toEqual([[1, true], [1, true], [2, false], [1, false], [2, false]])
    expect([digest.linesCut, digest.logLines]).toEqual([0, 24])
  })

  test("the cap keeps the summary and cuts failures, counting what it cut", () => {
    const digest = digestLog(CI, ["packages/sdk/src/guide.test.ts"], { maxLines: 3, detailLines: 3 })
    expect(digest.lines).toEqual([...CI_LINES.slice(0, 2), CI_SUMMARY])
    expect(digest.linesCut).toBe(6)
  })

  test("detailLines bounds the location lines a failure keeps", () => {
    const digest = digestLog(["error: boom", "  at a (x/a.ts:1:1)", "  at b (x/b.ts:2:2)"].join("\n"), [], { maxLines: 60, detailLines: 1 })
    expect(digest.lines).toEqual(["error: boom", "  at a (x/a.ts:1:1)"])
  })

  test("a log with no failure and no summary is empty", () => {
    expect(digestLog("all good\n", [])).toEqual({ summary: Option.none(), failures: [], failuresCut: 0, onChangedPath: false, lines: [], linesCut: 0, logLines: 1 })
  })

  test("escape sequences (OSC, CSI, others) and control characters are stripped, the CI prefix read first", () => {
    expect(plainText("a\u001b]8;;https://x.example\u0007link\u001b]8;;\u0007 \u001b[31mred\u001b[0m\u001bc\u0085\u0007z\tt")).toBe("alink redz\tt")
    const digest = digestLog("ci\tstep\t2026-11-19T11:47:00.5Z \u001b[31merror:\u001b[0m boom\u001b]0;title\u0007", [])
    expect(digest.lines).toEqual(["error: boom"])
  })

  test("a long failure line is cut with clipTo, its marker a line of its own counted against maxLines", () => {
    const digest = digestLog(`error: ${"x".repeat(400)}\nerror: second\n1 fail`, [], { maxLines: 3, detailLines: 3 })
    expect(digest.lines.length).toBe(3)
    expect(digest.lines[0]?.startsWith("error: xxx")).toBe(true)
    expect(digest.lines[1]).toMatch(/^\[… \d+ characters clipped\]$/)
    expect(digest.lines[2]).toBe("1 fail")
    expect(digest.linesCut).toBe(1)
  })

  test("failures and summary lines are bounded: the first FAILURES_KEPT failures, the last six summary lines", () => {
    const log = [...Array.from({ length: FAILURES_KEPT + 5 }, (_, at) => `error: failure ${at}`), ...Array.from({ length: 8 }, (_, at) => `${at} fail`)].join("\n")
    const digest = digestLog(log, [])
    expect([digest.failures.length, digest.failuresCut]).toEqual([FAILURES_KEPT, 5])
    expect(digest.summary).toEqual(Option.some("2 fail; 3 fail; 4 fail; 5 fail; 6 fail; 7 fail"))
  })
})
