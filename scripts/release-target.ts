#!/usr/bin/env bun
/** Read-only CI release selection. Candidate source is inspected with git show, never executed. */
import { appendFile, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Option, Result, Schema } from "effect"
import {
  CheckPages, CommitSha, DispatchEvent, releaseCandidate, releaseCommitFor, ReleaseFixture, ReleaseManifest,
  releaseSourceVersion, releaseVersionOf, RepositoryName, successfulSourceCi, WorkflowPages, WorkflowRunEvent,
} from "./release-target-plan.js"
import type { ReleaseEvent, ReleaseTarget } from "./release-target-plan.js"

interface Command { readonly success: boolean; readonly stdout: string; readonly stderr: string; readonly exitCode: number }
export interface ReleaseTargetOptions {
  readonly eventPath: string; readonly eventName: "workflow_run" | "workflow_dispatch"
  readonly repository: string; readonly root: string
}
export type ReleaseTargetSelection = ReleaseTarget | { readonly eligible: false; readonly reason: string }

const decode = <S extends Schema.Decoder<unknown>>(schema: S, text: string, label: string): S["Type"] => {
  const result = Schema.decodeUnknownResult(Schema.fromJsonString(schema))(text)
  if (Result.isFailure(result)) throw new Error(`${label} does not match its expected schema`)
  return result.success
}
const requireResult = <A>(result: Result.Result<A, string>): A => {
  if (Result.isFailure(result)) throw new Error(result.failure)
  return result.success
}
const run = (root: string, args: ReadonlyArray<string>): Command => {
  const result = Bun.spawnSync([...args], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 60_000 })
  return { success: result.success, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim(), exitCode: result.exitCode }
}
const required = (root: string, args: ReadonlyArray<string>, label: string): string => {
  const result = run(root, args)
  if (!result.success) throw new Error(`${label} failed`)
  return result.stdout
}

/** No GitHub writes, token inspection, candidate checkout, publication or tag mutation. */
export const selectReleaseTarget = async (options: ReleaseTargetOptions): Promise<ReleaseTargetSelection> => {
  if (Option.isNone(Schema.decodeUnknownOption(RepositoryName)(options.repository))) throw new Error("The expected repository must be owner/name")
  const text = await readFile(options.eventPath, "utf8")
  const event: ReleaseEvent = options.eventName === "workflow_run"
    ? { kind: "workflow_run", event: decode(WorkflowRunEvent, text, "The workflow event") }
    : { kind: "workflow_dispatch", event: decode(DispatchEvent, text, "The dispatch event") }
  const candidateResult = releaseCandidate(event, options.repository)
  if (Result.isFailure(candidateResult)) {
    if (options.eventName === "workflow_run") return { eligible: false, reason: candidateResult.failure }
    throw new Error(candidateResult.failure)
  }
  const candidate = candidateResult.success
  const sha = Option.match(candidate.sha, {
    onSome: (value) => value,
    onNone: () => requireResult(releaseCommitFor(required(options.root, ["git", "log", "--first-parent", "--format=%H%x09%s", "origin/main", "--"], "Reading main release history"), Option.getOrElse(candidate.requestedVersion, () => ""))),
  })
  if (Option.isNone(Schema.decodeUnknownOption(CommitSha)(sha))) throw new Error("The release target is not a full commit SHA")
  const commit = required(options.root, ["git", "rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`], "Resolving the release commit")
  if (commit !== sha) throw new Error("The release target must identify a commit directly")
  const title = required(options.root, ["git", "show", "-s", "--format=%s", sha, "--"], "Reading the release title")
  if (candidate.mode === "workflow_run" && Option.isNone(releaseVersionOf(title))) return { eligible: false, reason: "The CI commit is not a release commit" }
  const ancestry = run(options.root, ["git", "merge-base", "--is-ancestor", sha, "origin/main"])
  if (ancestry.exitCode > 1) throw new Error("The release ancestry could not be verified")
  const version = Option.getOrElse(releaseVersionOf(title), () => "")
  const show = (path: string) => required(options.root, ["git", "show", `${sha}:${path}`], `Reading release source ${path}`)
  const source = {
    manifest: decode(ReleaseManifest, show("packages/core/package.json"), "The source core manifest"),
    changelog: show("CHANGELOG.md"),
    journal: decode(ReleaseFixture, show(`packages/sdk/fixtures/journal-${version}.json`), "The release journal fixture"),
    evaluation: decode(ReleaseFixture, show(`packages/evals/fixtures/run-${version}.json`), "The release evaluation fixture"),
  }
  const checkedVersion = requireResult(releaseSourceVersion({ title, requestedVersion: candidate.requestedVersion, ancestorOfMain: ancestry.success, source }))
  const api = (endpoint: string) => required(options.root, ["gh", "api", "--hostname", "github.com", "--method", "GET", "--paginate", "--slurp", endpoint], "Reading source CI evidence from GitHub")
  const checks = decode(CheckPages, api(`repos/${options.repository}/commits/${sha}/check-runs?check_name=ci&filter=all&per_page=100`), "The source check runs").flatMap((page) => page.check_runs)
  const runs = decode(WorkflowPages, api(`repos/${options.repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`), "The source CI workflow runs").flatMap((page) => page.workflow_runs)
  requireResult(successfulSourceCi({ repository: candidate.repository, sha, sourceRunId: candidate.sourceRunId, checks, runs }))
  return { eligible: true, version: checkedVersion, sha, tag: `v${checkedVersion}` }
}

const usage = "Usage: bun scripts/release-target.ts --event <event.json> --event-name <workflow_run|workflow_dispatch> [--repo owner/name] [--root checkout]"
const argumentsOf = (args: ReadonlyArray<string>): ReleaseTargetOptions => {
  const allowed = new Set(["--event", "--event-name", "--repo", "--root"])
  if (args.length % 2 !== 0) throw new Error(usage)
  const entries = Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2] ?? "", args[index * 2 + 1] ?? ""] as const)
  if (entries.some(([key]) => !allowed.has(key)) || new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error(usage)
  const values = new Map(entries)
  const eventPath = values.get("--event")
  const eventName = values.get("--event-name")
  if (eventPath === undefined || (eventName !== "workflow_run" && eventName !== "workflow_dispatch")) throw new Error(usage)
  return { eventPath: resolve(eventPath), eventName, repository: values.get("--repo") ?? process.env.GITHUB_REPOSITORY ?? "xandreeddev/efferent", root: resolve(values.get("--root") ?? resolve(import.meta.dir, "..")) }
}
const output = async (selection: ReleaseTargetSelection): Promise<void> => {
  const fields = selection.eligible ? { eligible: "true", version: selection.version, sha: selection.sha, tag: selection.tag } : { eligible: "false", version: "", sha: "", tag: "" }
  const target = process.env.GITHUB_OUTPUT
  if (target !== undefined) await appendFile(target, Object.entries(fields).map(([key, value]) => `${key}=${value}\n`).join(""))
  console.log(JSON.stringify(selection))
}

if (import.meta.main) {
  try {
    await output(await selectReleaseTarget(argumentsOf(process.argv.slice(2))))
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "Release target validation failed"
    await output({ eligible: false, reason })
    process.exitCode = 1
  }
}
