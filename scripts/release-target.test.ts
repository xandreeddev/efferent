import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Option, Result, Schema } from "effect"
import {
  DispatchEvent, releaseCandidate, releaseCommitFor, releaseSourceVersion, releaseVersionOf, successfulSourceCi,
} from "./release-target-plan.js"
import type { CheckRun, ReleaseEvent, ReleaseSource, WorkflowRun } from "./release-target-plan.js"

const sha = "7eb972d259e80a0c88a99d81e84e9440aed884f0"
const otherSha = "1111111111111111111111111111111111111111"
const repository = { id: 42, full_name: "xandreeddev/efferent" }
const run: WorkflowRun = {
  id: 10, name: "ci", path: ".github/workflows/ci.yml", event: "push", head_branch: "main", head_sha: sha,
  status: "completed", conclusion: "success", check_suite_id: 20, repository, head_repository: repository,
}
const check: CheckRun = {
  id: 30, name: "ci", head_sha: sha, status: "completed", conclusion: "success",
  app: { id: 15368, slug: "github-actions" }, check_suite: { id: 20 },
}
const automatic = (changes: Partial<WorkflowRun> = {}): ReleaseEvent => ({ kind: "workflow_run", event: { action: "completed", repository, workflow_run: { ...run, ...changes } } })
const dispatch = (version = "0.16.0", commit?: string): ReleaseEvent => ({ kind: "workflow_dispatch", event: { repository, ref: "refs/heads/main", inputs: { version, ...(commit === undefined ? {} : { commit }) } } })
const source: ReleaseSource = {
  manifest: { name: "@xandreed/core", version: "0.16.0" },
  changelog: "# Changelog\n\n## Unreleased\n\n## 0.16.0 — 2026-11-03\n\nRelease evidence.",
  journal: { version: "0.16.0" }, evaluation: { version: "0.16.0" },
}
const eligibility = (changes: Partial<Parameters<typeof releaseSourceVersion>[0]> = {}) => releaseSourceVersion({ title: "release 0.16.0", requestedVersion: Option.none(), ancestorOfMain: true, source, ...changes })
const ci = (changes: Partial<Parameters<typeof successfulSourceCi>[0]> = {}) => successfulSourceCi({ repository, sha, sourceRunId: Option.none(), checks: [check], runs: [run], ...changes })

describe("release selection", () => {
  test("automatic selection accepts only successful base-repository push CI on main", () => {
    expect(releaseCandidate(automatic(), repository.full_name)._tag).toBe("Success")
    for (const changes of [
      { event: "pull_request" }, { head_branch: "future" }, { conclusion: "failure" },
      { status: "in_progress", conclusion: null }, { name: "another workflow" }, { path: ".github/workflows/fake.yml" },
      { head_repository: { id: 99, full_name: "someone/efferent" } }, { head_repository: null },
    ]) expect(releaseCandidate(automatic(changes), repository.full_name)._tag).toBe("Failure")
    expect(releaseCandidate(automatic(), "other/repository")._tag).toBe("Failure")
  })

  test("release titles are complete and version-only dispatch selects the original release", () => {
    expect(releaseVersionOf("release 0.16.0 (#463)")).toEqual(Option.some("0.16.0"))
    expect(releaseVersionOf("release 0.16.0 #463")).toEqual(Option.some("0.16.0"))
    for (const title of ["add CI releases", "release 0.16.0 with fixes", "release 00.16.0", "release 0.16.0\n", "release 0.16.0-01", "release 0.17.0-beta", "release 0.17.0+build", "release 1.2.3-rc.1+build.2"]) expect(releaseVersionOf(title)).toEqual(Option.none())
    const history = `${otherSha}\tadd workflow while core remains 0.16.0\n${sha}\trelease 0.16.0\n`
    expect(releaseCommitFor(history, "0.16.0")).toEqual(Result.succeed(sha))
    expect(releaseCommitFor(history, "0.17.0")._tag).toBe("Failure")
    expect(releaseCommitFor(`${history}${otherSha}\trelease 0.16.0`, "0.16.0")._tag).toBe("Failure")
    expect(releaseCandidate(dispatch("0.16.0", "--evil"), repository.full_name)._tag).toBe("Failure")
    expect(releaseCandidate(dispatch("0.16.0", sha), repository.full_name)._tag).toBe("Success")
  })

  test("dispatch rejects prereleases and build metadata at the input boundary", () => {
    expect(Option.isSome(Schema.decodeUnknownOption(DispatchEvent)(dispatch("0.17.0").event))).toBe(true)
    for (const version of ["0.17.0-beta", "0.17.0+build", "0.17.0-beta.1+build.2"]) {
      expect(Schema.decodeUnknownOption(DispatchEvent)(dispatch(version).event)).toEqual(Option.none())
    }
  })

  test("manual dispatch accepts both main spellings and rejects other branches and tag refs", () => {
    for (const ref of ["main", "refs/heads/main", "future", "refs/heads/future", "refs/tags/main", "refs/tags/v0.16.0", "refs/heads/main/extra"]) {
      const event: ReleaseEvent = { kind: "workflow_dispatch", event: { repository, ref, inputs: { version: "0.16.0" } } }
      expect(releaseCandidate(event, repository.full_name)._tag).toBe(ref === "main" || ref === "refs/heads/main" ? "Success" : "Failure")
    }
  })

  test("source must be a main ancestor with matching release title, manifest, date and fixtures", () => {
    expect(eligibility()).toEqual(Result.succeed("0.16.0"))
    expect(eligibility({ title: "fix a feature", requestedVersion: Option.some("0.16.0") })._tag).toBe("Failure")
    expect(eligibility({ ancestorOfMain: false })._tag).toBe("Failure")
    expect(eligibility({ requestedVersion: Option.some("0.17.0") })._tag).toBe("Failure")
    expect(eligibility({ source: { ...source, manifest: { ...source.manifest, version: "0.15.1" } } })._tag).toBe("Failure")
    expect(eligibility({ source: { ...source, changelog: "## 0.16.0\n" } })._tag).toBe("Failure")
    expect(eligibility({ source: { ...source, journal: { version: "0.15.1" } } })._tag).toBe("Failure")
    expect(eligibility({ source: { ...source, evaluation: { version: "0.15.1" } } })._tag).toBe("Failure")
  })

  test("only the exact Actions check and its successful main-push workflow run count", () => {
    expect(ci()).toEqual(Result.succeed(run.id))
    for (const changed of [
      { app: { id: 999, slug: "github-actions" } }, { app: { id: 15368, slug: "shadow" } },
      { status: "in_progress", conclusion: null }, { conclusion: "failure" }, { head_sha: otherSha }, { check_suite: { id: 999 } },
    ]) expect(ci({ checks: [{ ...check, ...changed }] })._tag).toBe("Failure")
    expect(ci({ runs: [{ ...run, event: "pull_request" }] })._tag).toBe("Failure")
    expect(ci({ runs: [{ ...run, head_repository: { id: 99, full_name: "someone/efferent" } }] })._tag).toBe("Failure")
    expect(ci({ runs: [{ ...run, path: ".github/workflows/shadow.yml" }] })._tag).toBe("Failure")
    expect(ci({ sourceRunId: Option.some(999) })._tag).toBe("Failure")
  })

  test("older green checks cannot override a pending or failed trusted rerun", () => {
    expect(ci({ checks: [check, { ...check, id: 31, status: "in_progress", conclusion: null }] })._tag).toBe("Failure")
    expect(ci({ runs: [run, { ...run, id: 11, status: "completed", conclusion: "failure" }] })._tag).toBe("Failure")
    expect(ci({ checks: [check, { ...check, id: 99, app: { id: 999, slug: "shadow" }, conclusion: "success" }] })).toEqual(Result.succeed(run.id))
  })
})

test("the CLI reads the historical release blobs and emits safe outputs without executing source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "efferent-release-target-"))
  try {
    const git = (...args: ReadonlyArray<string>) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
      if (!result.success) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    git("init", "--initial-branch=main")
    git("config", "user.name", "Release fixture")
    git("config", "user.email", "fixture@example.invalid")
    await mkdir(join(directory, "packages/core"), { recursive: true })
    await mkdir(join(directory, "packages/sdk/fixtures"), { recursive: true })
    await mkdir(join(directory, "packages/evals/fixtures"), { recursive: true })
    await writeFile(join(directory, "packages/core/package.json"), JSON.stringify(source.manifest))
    await writeFile(join(directory, "packages/sdk/fixtures/journal-0.16.0.json"), JSON.stringify(source.journal))
    await writeFile(join(directory, "packages/evals/fixtures/run-0.16.0.json"), JSON.stringify(source.evaluation))
    await writeFile(join(directory, "CHANGELOG.md"), source.changelog)
    git("add", ".")
    git("commit", "--no-verify", "-m", "release 0.16.0")
    const released = git("rev-parse", "HEAD")
    await writeFile(join(directory, "packages/core/package.json"), JSON.stringify({ ...source.manifest, version: "0.17.0" }))
    git("add", ".")
    git("commit", "--no-verify", "-m", "start another version")
    git("update-ref", "refs/remotes/origin/main", "HEAD")
    const bin = join(directory, "bin")
    await mkdir(bin)
    const pages = {
      checks: [{ check_runs: [{ ...check, head_sha: released }] }],
      runs: [{ workflow_runs: [{ ...run, head_sha: released }] }],
    }
    await writeFile(join(directory, "pages.json"), JSON.stringify(pages))
    await writeFile(join(bin, "gh"), `#!/usr/bin/env bun\nconst pages=await Bun.file(${JSON.stringify(join(directory, "pages.json"))}).json();\nconst endpoint=process.argv.at(-1);\nif(process.argv[2]!=="api"||!process.argv.includes("GET"))process.exit(2);\nconsole.log(JSON.stringify(endpoint.includes("check-runs")?pages.checks:pages.runs));\n`, { mode: 0o755 })
    const eventPath = join(directory, "event.json")
    await writeFile(eventPath, JSON.stringify({ ...dispatch().event, ref: "main" }))
    const output = join(directory, "outputs")
    const child = Bun.spawn(["bun", join(import.meta.dir, "release-target.ts"), "--event", eventPath, "--event-name", "workflow_dispatch", "--root", directory, "--repo", repository.full_name], {
      cwd: directory, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output }, stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ eligible: true, version: "0.16.0", sha: released, tag: "v0.16.0" })
    expect(await readFile(output, "utf8")).toBe(`eligible=true\nversion=0.16.0\nsha=${released}\ntag=v0.16.0\n`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
