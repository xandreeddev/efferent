import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { cliLine, reviewCli } from "./cli.adapter.js"

const host = { env: {}, cwd: "/", home: "/home/user" }

const usageOf = async (args: ReadonlyArray<string>) => {
  const exit = await Effect.runPromiseExit(reviewCli(args, host))
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return reason?._tag === "Fail" && reason.error._tag === "UsageError" ? reason.error.message.split("\n")[0] : "not a usage error"
}

describe("cliLine", () => {
  test("reads words, valued flags in both spellings, a repeated --workflow whole (never split at commas), and switches", async () => {
    const line = await Effect.runPromise(cliLine(["prepare", "655", "--repo=owner/project", "--workflow", ".github/workflows/a,b.yml", "--workflow=.github/workflows/ci.yml", "--json", "--budget", "100"]))
    expect([line.words, [...line.values.entries()], [...line.switches]]).toEqual([
      ["prepare", "655"],
      [["--repo", ["owner/project"]], ["--workflow", [".github/workflows/a,b.yml", ".github/workflows/ci.yml"]], ["--budget", ["100"]]],
      ["--json"],
    ])
  })
})

describe("reviewCli", () => {
  test.each([
    [["prepare"], "efferent-review takes the command prepare and a pull request's number"],
    [["review", "1", "--repo", "a/b"], "efferent-review takes the command prepare and a pull request's number"],
    [["prepare", "1"], "--repo (owner/name) is not valid"],
    [["prepare", "1", "--repo", "a/b; rm -rf x"], "--repo (owner/name) is not valid"],
    [["prepare", "1", "--repo", "../b"], "--repo (owner/name) is not valid"],
    [["prepare", "1", "--repo", "a/.."], "--repo (owner/name) is not valid"],
    [["prepare", "1", "--repo", "./."], "--repo (owner/name) is not valid"],
    [["prepare", "0", "--repo", "a/b"], "the pull request's number is not valid"],
    [["prepare", "1", "--repo", "a/b", "--budget", "lots"], "--budget must be a whole number of at least 1, not \"lots\""],
    [["prepare", "1", "--repo", "a/b", "--repo", "c/d"], "--repo is given more than once"],
    [["prepare", "1", "--repo"], "--repo needs a value"],
    [["prepare", "1", "--repo", "a/b", "--fast"], "--fast is not a flag of efferent-review"],
    [["prepare", "1", "--repo", "a/b", "--run", "bun test"], "--run is not a flag of efferent-review"],
  ] as const)("%j is a usage error", async (args, message) => {
    expect(await usageOf(args)).toBe(message)
  })
})
