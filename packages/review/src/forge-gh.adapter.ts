import { Effect, Layer, Option, Schema } from "effect"
import { ForgeUnreadable, RunId } from "./forge.entity.js"
import type { CheckRun, CiRun, FailedLog } from "./forge.entity.js"
import { Forge } from "./forge.port.js"
import { CommandFailed } from "./host-command.entity.js"
import { commandLine } from "./host-command.entity.functions.js"
import { runWhole } from "./host-shell.adapter.js"
import type { HostShell } from "./host-shell.port.js"
import { Permission, PullRequest } from "./pull-request.entity.js"
import type { CommitSha, PullNumber, RepoName } from "./pull-request.entity.js"

/** The fields `gh pr view --json` is asked for. */
export const PULL_FIELDS = "number,title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,files,commits"

const GhPull = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  author: Schema.Struct({ login: Schema.String, is_bot: Schema.optionalKey(Schema.Boolean) }),
  baseRefName: Schema.String,
  baseRefOid: Schema.String,
  headRefName: Schema.String,
  headRefOid: Schema.String,
  headRepository: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  headRepositoryOwner: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  isCrossRepository: Schema.Boolean,
  files: Schema.Array(Schema.Struct({ path: Schema.String, additions: Schema.Int, deletions: Schema.Int })),
  commits: Schema.Array(Schema.Struct({ oid: Schema.String, messageHeadline: Schema.String, authoredDate: Schema.String, committedDate: Schema.String })),
})

const GhPermission = Schema.Struct({ permission: Schema.String, role_name: Schema.optionalKey(Schema.String) })

const GhRuns = Schema.Struct({
  workflow_runs: Schema.Array(Schema.Struct({
    id: Schema.Int,
    name: Schema.NullOr(Schema.String),
    path: Schema.String,
    event: Schema.String,
    status: Schema.NullOr(Schema.String),
    conclusion: Schema.NullOr(Schema.String),
    html_url: Schema.String,
    run_attempt: Schema.Int,
  })),
})

const GhJobs = Schema.Struct({
  total_count: Schema.Int,
  jobs: Schema.Array(Schema.Struct({
    name: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    html_url: Schema.NullOr(Schema.String),
  })),
})

/** Decode a command's JSON output, a failure naming the command. */
const decoded = <A, I>(schema: Schema.Codec<A, I>, args: ReadonlyArray<string>, text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError((cause) => new ForgeUnreadable({ command: commandLine(args), message: `the answer of ${args.slice(0, 2).join(" ")} does not read as expected`, cause })),
  )

/** Words in a failed `gh run view --log-failed` that say the log is gone or was never kept: an absence, not a failure. */
const NO_LOG = /log not found|not found|expired|no longer available|HTTP 410|gone/i

/** The permission the forge names, `role_name` (which tells `maintain` and `triage` apart) before `permission`. */
const permissionOf = (answer: typeof GhPermission.Type): Permission => {
  const named = [answer.role_name, answer.permission].find((value) => Schema.is(Permission)(value))
  return Schema.is(Permission)(named) ? named : "none"
}

/**
 * The forge through the GitHub CLI, `gh`, on the host's shell (which keeps the host's environment, where `gh` reads
 * its login). Every output it parses is read whole (`runWhole`). The author's permission is asked of
 * `repos/<repo>/collaborators/<login>/permission`; a bot, and an answer that fails or names no permission, is `none`.
 */
export const ghForge: Layer.Layer<Forge, never, HostShell> = Layer.effect(Forge, Effect.gen(function* () {
  const host = yield* Effect.context<HostShell>()
  const provided = <A, E>(effect: Effect.Effect<A, E, HostShell>) => Effect.provide(effect, host)

  const permission = Effect.fnUntraced(function* (repo: RepoName, login: string, bot: boolean) {
    if (bot) return "none" as const
    const args = ["gh", "api", `repos/${repo}/collaborators/${login}/permission`]
    return yield* runWhole(args).pipe(
      Effect.flatMap((whole) => decoded(GhPermission, args, whole.stdout)),
      Effect.map(permissionOf),
      Effect.tapError((error) => Effect.logWarning("the author's permission could not be read, so it is taken as none", error)),
      Effect.catch(() => Effect.succeed<Permission>("none")),
    )
  })

  const pullRequest = Effect.fn("forge.pull_request")(function* (repo: RepoName, number: PullNumber) {
    const args = ["gh", "pr", "view", String(number), "--repo", repo, "--json", PULL_FIELDS]
    const pull = yield* decoded(GhPull, args, (yield* runWhole(args)).stdout)
    const headRepo = pull.headRepository !== null && pull.headRepositoryOwner !== null ? `${pull.headRepositoryOwner.login}/${pull.headRepository.name}` : null
    const bot = pull.author.is_bot ?? false
    const encoded: typeof PullRequest.Encoded = {
      repo,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      author: pull.author.login,
      authorIsBot: bot,
      permission: yield* permission(repo, pull.author.login, bot),
      base: { ref: pull.baseRefName, sha: pull.baseRefOid },
      head: { ref: pull.headRefName, sha: pull.headRefOid },
      headRepo,
      sameRepo: !pull.isCrossRepository && headRepo !== null && headRepo.toLowerCase() === repo.toLowerCase(),
      files: pull.files,
      commits: pull.commits.map((commit) => ({ sha: commit.oid, headline: commit.messageHeadline, authoredAt: commit.authoredDate, committedAt: commit.committedDate })),
    }
    return yield* Schema.decodeUnknownEffect(PullRequest)(encoded).pipe(
      Effect.mapError((cause) => new ForgeUnreadable({ command: commandLine(args), message: "the pull request does not read as one: a sha, a branch or a login is not what it should be", cause })),
    )
  }, provided)

  const checksOf = Effect.fnUntraced(function* (repo: RepoName, id: number) {
    const args = ["gh", "api", `repos/${repo}/actions/runs/${id}/jobs?per_page=100`]
    const jobs = yield* decoded(GhJobs, args, (yield* runWhole(args)).stdout)
    const checks: ReadonlyArray<CheckRun> = jobs.jobs.map((job) => ({ name: job.name, status: job.status, conclusion: Option.fromNullishOr(job.conclusion), url: job.html_url ?? "" }))
    return { count: jobs.total_count, checks }
  })

  const ciRuns = Effect.fn("forge.ci_runs")(function* (repo: RepoName, head: CommitSha, workflows: ReadonlyArray<string>) {
    const args = ["gh", "api", `repos/${repo}/actions/runs?head_sha=${head}&event=pull_request&per_page=100`]
    const runs = (yield* decoded(GhRuns, args, (yield* runWhole(args)).stdout)).workflow_runs
      .filter((run) => run.event === "pull_request" && (workflows.length === 0 || workflows.includes(run.path)))
    const listed = yield* Effect.forEach(runs, (run) => Effect.map(checksOf(repo, run.id), (jobs) => ({ run, jobs })), { concurrency: 4 })
    return listed.flatMap(({ run, jobs }): ReadonlyArray<CiRun> => jobs.count === 0 ? [] : [{
      id: RunId.make(run.id),
      name: run.name ?? run.path,
      workflowPath: run.path,
      event: run.event,
      status: run.status ?? "unknown",
      conclusion: Option.fromNullishOr(run.conclusion),
      url: run.html_url,
      attempt: run.run_attempt,
      checks: jobs.checks,
    }])
  }, provided)

  const failedLog = Effect.fn("forge.failed_log")(function* (repo: RepoName, run: RunId) {
    const args = ["gh", "run", "view", String(run), "--repo", repo, "--log-failed"]
    const whole = yield* runWhole(args, { exits: [0, 1] })
    const log: FailedLog = whole.code === 0
      ? whole.stdout.trim().length > 0 ? { _tag: "Log", text: whole.stdout } : { _tag: "NoLog", reason: "the run has no failed step with a log" }
      : NO_LOG.test(whole.stderr) ? { _tag: "NoLog", reason: whole.stderr.trim().slice(0, 200) } : yield* Effect.fail(new CommandFailed({ reason: "exited", command: commandLine(args), message: `exited with 1: ${whole.stderr.trim().slice(-600)}` }))
    return log
  }, provided)

  return Forge.of({ pullRequest, ciRuns, failedLog })
}))
