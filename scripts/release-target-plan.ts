import { Option, Result, Schema } from "effect"

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const ReleaseVersion = Schema.String.check(Schema.isMaxLength(128), Schema.isPattern(stableVersion))
export const CommitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
export const RepositoryName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/),
  Schema.makeFilter((value) => !value.endsWith("/.") && !value.endsWith("/..") || "Expected a GitHub owner/repository name"),
)
const Repository = Schema.Struct({ id: Schema.Int.check(Schema.isGreaterThan(0)), full_name: RepositoryName })
export type Repository = typeof Repository.Type

export const WorkflowRun = Schema.Struct({
  id: Schema.Int, name: Schema.String, path: Schema.String,
  event: Schema.String, head_branch: Schema.NullOr(Schema.String), head_sha: CommitSha,
  status: Schema.String, conclusion: Schema.NullOr(Schema.String), check_suite_id: Schema.Int,
  repository: Repository, head_repository: Schema.NullOr(Repository),
})
export type WorkflowRun = typeof WorkflowRun.Type
export const CheckRun = Schema.Struct({
  id: Schema.Int, name: Schema.String, head_sha: CommitSha,
  status: Schema.String, conclusion: Schema.NullOr(Schema.String),
  app: Schema.NullOr(Schema.Struct({ id: Schema.Int, slug: Schema.String })),
  check_suite: Schema.Struct({ id: Schema.Int }),
})
export type CheckRun = typeof CheckRun.Type
export const CheckPages = Schema.Array(Schema.Struct({ check_runs: Schema.Array(CheckRun) }))
export const WorkflowPages = Schema.Array(Schema.Struct({ workflow_runs: Schema.Array(WorkflowRun) }))
export const ReleaseManifest = Schema.Struct({ name: Schema.String, version: ReleaseVersion })
export const ReleaseFixture = Schema.Struct({ version: ReleaseVersion })
export const WorkflowRunEvent = Schema.Struct({ action: Schema.String, repository: Repository, workflow_run: WorkflowRun })
export const DispatchEvent = Schema.Struct({
  ref: Schema.String, repository: Repository,
  inputs: Schema.Struct({ version: ReleaseVersion, commit: Schema.optionalKey(Schema.String) }),
})
export type ReleaseEvent =
  | { readonly kind: "workflow_run"; readonly event: typeof WorkflowRunEvent.Type }
  | { readonly kind: "workflow_dispatch"; readonly event: typeof DispatchEvent.Type }

export interface ReleaseCandidate {
  readonly mode: ReleaseEvent["kind"]
  readonly repository: Repository
  readonly requestedVersion: Option.Option<string>
  readonly sha: Option.Option<string>
  readonly sourceRunId: Option.Option<number>
}
export interface ReleaseTarget { readonly eligible: true; readonly version: string; readonly sha: string; readonly tag: string }
export interface ReleaseSource {
  readonly manifest: typeof ReleaseManifest.Type
  readonly changelog: string
  readonly journal: typeof ReleaseFixture.Type
  readonly evaluation: typeof ReleaseFixture.Type
}

const sameRepository = (left: Repository, right: Repository) => left.id === right.id && left.full_name.toLowerCase() === right.full_name.toLowerCase()

/** Only complete release titles qualify; ordinary changes retaining the last version do not. */
export const releaseVersionOf = (title: string): Option.Option<string> => {
  const match = /^release (\S+?)(?: \(#\d+\)| #\d+)?$/.exec(title)
  return match?.[1] === undefined ? Option.none() : Schema.decodeUnknownOption(ReleaseVersion)(match[1])
}

/** Reject PR/fork/workflow-branch events before reading any candidate source. */
export const releaseCandidate = (input: ReleaseEvent, expectedRepository: string): Result.Result<ReleaseCandidate, string> => {
  const repository = input.event.repository
  if (repository.full_name.toLowerCase() !== expectedRepository.toLowerCase()) return Result.fail("The event belongs to another repository")
  if (input.kind === "workflow_dispatch") {
    if (input.event.ref !== "refs/heads/main" && input.event.ref !== "main") return Result.fail("Manual releases must run the workflow from main")
    const selected = input.event.inputs.commit?.trim() ?? ""
    if (selected !== "" && Option.isNone(Schema.decodeUnknownOption(CommitSha)(selected))) return Result.fail("The optional commit must be a complete lowercase 40-character SHA")
    return Result.succeed({ mode: input.kind, repository, requestedVersion: Option.some(input.event.inputs.version), sha: selected === "" ? Option.none() : Option.some(selected), sourceRunId: Option.none() })
  }
  const run = input.event.workflow_run
  if (input.event.action !== "completed" || run.status !== "completed" || run.conclusion !== "success") return Result.fail("The source CI run did not complete successfully")
  if (run.name !== "ci" || run.path !== ".github/workflows/ci.yml" || run.event !== "push" || run.head_branch !== "main") return Result.fail("Only the main push CI workflow may trigger an automatic release")
  if (!sameRepository(run.repository, repository) || run.head_repository === null || !sameRepository(run.head_repository, repository)) return Result.fail("Fork CI runs cannot select a release")
  return Result.succeed({ mode: input.kind, repository, requestedVersion: Option.none(), sha: Option.some(run.head_sha), sourceRunId: Option.some(run.id) })
}

/** A version-only dispatch selects the original release commit, never a newer feature commit. */
export const releaseCommitFor = (history: string, version: string): Result.Result<string, string> => {
  const candidates = history.split("\n").flatMap((line) => {
    const separator = line.indexOf("\t")
    if (separator < 0) return []
    const sha = line.slice(0, separator)
    const title = line.slice(separator + 1)
    return Option.isSome(Schema.decodeUnknownOption(CommitSha)(sha)) && Option.contains(releaseVersionOf(title), version) ? [sha] : []
  })
  const unique = [...new Set(candidates)]
  return unique.length === 1 && unique[0] !== undefined ? Result.succeed(unique[0]) : Result.fail(unique.length === 0
    ? "No matching release commit exists on origin/main"
    : "Multiple release commits declare this version; specify the intended full commit SHA")
}

/** Read from GitHub, then bind the real Actions job to the exact main-push CI workflow run. */
export const successfulSourceCi = (input: {
  readonly repository: Repository; readonly sha: string; readonly sourceRunId: Option.Option<number>
  readonly runs: ReadonlyArray<WorkflowRun>; readonly checks: ReadonlyArray<CheckRun>
}): Result.Result<number, string> => {
  const runs = input.runs.filter((run) => run.name === "ci" && run.path === ".github/workflows/ci.yml" && run.event === "push" && run.head_branch === "main" && run.head_sha === input.sha
    && sameRepository(run.repository, input.repository) && run.head_repository !== null && sameRepository(run.head_repository, input.repository))
    .toSorted((left, right) => right.id - left.id)
  const latest = runs[0]
  if (latest === undefined || latest.status !== "completed" || latest.conclusion !== "success") return Result.fail("The exact release commit has no successful completed main-push CI run")
  if (Option.isSome(input.sourceRunId) && input.sourceRunId.value !== latest.id) return Result.fail("The triggering CI run is no longer the latest source CI run")
  const check = input.checks.filter((check) => check.name === "ci" && check.head_sha === input.sha && check.check_suite.id === latest.check_suite_id
    && check.app?.id === 15368 && check.app.slug === "github-actions")
    .toSorted((left, right) => right.id - left.id)[0]
  if (check === undefined || check.status !== "completed" || check.conclusion !== "success") return Result.fail("The release commit's ci check is not a successful completed GitHub Actions check")
  return Result.succeed(latest.id)
}

export const releaseSourceVersion = (input: {
  readonly title: string; readonly requestedVersion: Option.Option<string>; readonly ancestorOfMain: boolean; readonly source: ReleaseSource
}): Result.Result<string, string> => {
  if (!input.ancestorOfMain) return Result.fail("The release commit is not reachable from origin/main")
  const titleVersion = releaseVersionOf(input.title)
  if (Option.isNone(titleVersion)) return Result.fail("The candidate commit does not have an exact release title")
  const version = titleVersion.value
  if (Option.isSome(input.requestedVersion) && input.requestedVersion.value !== version) return Result.fail("The requested version differs from the release commit title")
  if (input.source.manifest.name !== "@xandreed/core" || input.source.manifest.version !== version) return Result.fail("The source core manifest differs from the release version")
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (!new RegExp(`^## ${escaped} — \\d{4}-\\d{2}-\\d{2}$`, "m").test(input.source.changelog)) return Result.fail("The source changelog has no dated entry for the release")
  if (input.source.journal.version !== version || input.source.evaluation.version !== version) return Result.fail("The release journal and evaluation fixtures must name the source version")
  return Result.succeed(version)
}
