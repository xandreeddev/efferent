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

test("reads --run whole and again for more, and --validate", async () => {
  const line = await Effect.runPromise(cliLine(["prepare", "1", "--run", "bun run typecheck", "--run=bun test packages/review", "--validate"]))
  expect([line.values.get("--run"), [...line.switches]]).toEqual([["bun run typecheck", "bun test packages/review"], ["--validate"]])
})

test("asked to run commands on a host with no bwrap, the command line fails with SandboxUnavailable before anything is read", async () => {
  const exit = await Effect.runPromiseExit(reviewCli(["prepare", "1", "--repo", "a/b", "--validate", "--cache", "/nonexistent/cache"], { ...host, env: { PATH: "/nonexistent" } }))
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  expect(reason?._tag === "Fail" ? [reason.error._tag, reason.error.message] : "no failure").toEqual(["SandboxUnavailable", "bwrap (bubblewrap) is not installed on this host, so nothing of a pull request's runs"])
})

describe("reviewCli", () => {
  test.each([
    [["prepare"], "efferent-review takes the command prepare or review and a pull request's number"],
    [["merge", "1", "--repo", "a/b"], "efferent-review takes the command prepare or review and a pull request's number"],
    [["review", "1", "--repo", "a/b"], "review needs the model's key in the environment variable VERCEL_API_KEY"],
    [["review", "1", "--repo", "a/b", "--max-cost", "-1"], "--max-cost must be a positive number of USD, not \"-1\""],
    [["prepare", "1", "--repo", "a/b", "--max-cost", "0.1"], "--max-cost is a flag of review, not of prepare"],
    [["prepare", "1", "--repo", "a/b", "--max-steps", "4"], "--max-steps is a flag of review, not of prepare"],
    [["review", "1", "--repo", "a/b", "--max-steps", "0"], "--max-steps must be a whole number of at least 1, not \"0\""],
    [["review", "1", "--repo", "a/b", "--model", "other/model"], "--model other/model needs its --price (input,cached,output, USD per million tokens)"],
    [["review", "1", "--repo", "a/b", "--model", "other/model", "--price", "1,2"], "--price must be three numbers of USD per million tokens, input,cached,output, not \"1,2\""],
    [["review", "1", "--repo", "a/b", "--model", "other/model", "--price", "1,0.1,2"], "review needs the model's key in the environment variable VERCEL_API_KEY"],
    [["prepare", "1", "--repo", "a/b", "--at", "latest"], "--at (head, first or a commit's full sha) is not valid"],
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
    [["prepare", "1", "--repo", "a/b", "--validate=yes"], "--validate=yes is not a flag of efferent-review"],
  ] as const)("%j is a usage error", async (args, message) => {
    expect(await usageOf(args)).toBe(message)
  })
})
