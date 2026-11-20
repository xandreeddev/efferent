import { Effect, Layer, Option, Schema } from "effect"
import { clipTo } from "@xandreed/sdk"
import { plainText } from "./log-digest.entity.functions.js"
import { DESCRIPTION_EDITS_READ, ForgeUnreadable, RunId } from "./forge.entity.js"
import type { CheckRun, CiRun, DescriptionHistory, FailedLog, PullTimeline } from "./forge.entity.js"
import { firstHeadOf } from "./forge.entity.functions.js"
import { Forge } from "./forge.port.js"
import { CommandFailed } from "./host-command.entity.js"
import { commandLine } from "./host-command.entity.functions.js"
import { runWhole } from "./host-shell.adapter.js"
import type { HostShell } from "./host-shell.port.js"
import { BranchName, Permission, PullRequest } from "./pull-request.entity.js"
import type { CommitSha, PullNumber, PullRequest as Pull, RepoName } from "./pull-request.entity.js"

/** What `gh api repos/<repo>` is read for: the default branch's name. */
const GhRepo = Schema.Struct({ default_branch: BranchName })

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

const GhBranchRuns = Schema.Struct({
  workflow_runs: Schema.Array(Schema.Struct({ head_sha: Schema.String, created_at: Schema.String })),
})

/**
 * The GraphQL query for a pull request's timeline: when it was opened and closed, and its first 100 force-pushes with
 * the head each replaced.
 */
export const TIMELINE_QUERY = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { createdAt closedAt timelineItems(first: 100, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) { nodes { ... on HeadRefForcePushedEvent { createdAt beforeCommit { oid } } } } } } }"

const GhTimeline = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        createdAt: Schema.String,
        closedAt: Schema.NullOr(Schema.String),
        timelineItems: Schema.Struct({
          nodes: Schema.Array(Schema.Struct({ createdAt: Schema.String, beforeCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String })) })),
        }),
      }),
    }),
  }),
})

/**
 * The GraphQL query for when a commit was committed and the saved versions of a pull request's description (its
 * first `DESCRIPTION_EDITS_READ`, newest first, and how many there are in all; each version's text is its `diff`).
 */
export const DESCRIPTION_QUERY = `query($owner: String!, $name: String!, $number: Int!, $sha: GitObjectID!) { repository(owner: $owner, name: $name) { object(oid: $sha) { ... on Commit { committedDate } } pullRequest(number: $number) { userContentEdits(first: ${DESCRIPTION_EDITS_READ}) { totalCount nodes { editedAt diff } } } } }`

const GhDescription = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      object: Schema.NullOr(Schema.Struct({ committedDate: Schema.String })),
      pullRequest: Schema.Struct({
        userContentEdits: Schema.Struct({
          totalCount: Schema.Int,
          nodes: Schema.Array(Schema.Struct({ editedAt: Schema.String, diff: Schema.NullOr(Schema.String) })),
        }),
      }),
    }),
  }),
})

const GhJobs = Schema.Struct({
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
/**
 * What `gh run view --log-failed` says of a log the forge no longer has or never kept: an absence, not a failure.
 * Anything else (an auth or repository 404, a network error) is a failure with its reason.
 */
const NO_LOG = /failed to get run log: log not found|HTTP 410/

/** The events whose CI runs for a head are read. */
export const CI_EVENTS: ReadonlyArray<string> = ["pull_request", "push", "merge_group", "pull_request_target"]

/** The permission the forge names, `role_name` (which tells `maintain` and `triage` apart) before `permission`. */
const permissionOf = (answer: typeof GhPermission.Type): Permission => {
  const named = [answer.role_name, answer.permission].find((value) => Schema.is(Permission)(value))
  return Schema.is(Permission)(named) ? named : "none"
}

/**
 * The forge through the GitHub CLI, `gh`, on the host's shell (which keeps the host's environment, where `gh` reads
 * its login). Every output it parses is read whole (`runWhole`), every page of a list (`--paginate --slurp`). CI runs
 * are those of the head's sha started by one of `CI_EVENTS`, a run with no job left out. The author's permission is asked of
 * `repos/<repo>/collaborators/<login>/permission`; a bot, and an answer that fails or names no permission, is `none`.
 * The first head is read from the head branch's `pull_request` runs started while the pull request was open, and its
 * timeline's force-pushes (`TIMELINE_QUERY`, `firstHeadOf`): GitHub empties a run's `pull_requests` once its pull
 * request is merged, and a force-push drops the first head from the commit list but never from the runs.
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
      fetchRef: `refs/pull/${pull.number}/head`,
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
    const args = ["gh", "api", "--paginate", "--slurp", `repos/${repo}/actions/runs/${id}/jobs?per_page=100`]
    const pages = yield* decoded(Schema.Array(GhJobs), args, (yield* runWhole(args)).stdout)
    const checks: ReadonlyArray<CheckRun> = pages.flatMap((page) => page.jobs).map((job) => ({ name: job.name, status: job.status, conclusion: Option.fromNullishOr(job.conclusion), url: job.html_url ?? "" }))
    return checks
  })

  const ciRuns = Effect.fn("forge.ci_runs")(function* (repo: RepoName, head: CommitSha, workflows: ReadonlyArray<string>) {
    const args = ["gh", "api", "--paginate", "--slurp", `repos/${repo}/actions/runs?head_sha=${head}&per_page=100`]
    const runs = (yield* decoded(Schema.Array(GhRuns), args, (yield* runWhole(args)).stdout)).flatMap((page) => page.workflow_runs)
      .filter((run) => CI_EVENTS.includes(run.event) && (workflows.length === 0 || workflows.includes(run.path)))
    const listed = yield* Effect.forEach(runs, (run) => Effect.map(checksOf(repo, run.id), (checks) => ({ run, checks })), { concurrency: 4 })
    return listed.flatMap(({ run, checks }): ReadonlyArray<CiRun> => checks.length === 0 ? [] : [{
      id: RunId.make(run.id),
      name: run.name ?? run.path,
      workflowPath: run.path,
      event: run.event,
      status: run.status ?? "unknown",
      conclusion: Option.fromNullishOr(run.conclusion),
      url: run.html_url,
      attempt: run.run_attempt,
      checks,
    }])
  }, provided)

  const failedLog = Effect.fn("forge.failed_log")(function* (repo: RepoName, run: RunId) {
    const args = ["gh", "run", "view", String(run), "--repo", repo, "--log-failed"]
    const whole = yield* runWhole(args, { exits: [0, 1] })
    const log: FailedLog = whole.code === 0
      ? whole.stdout.trim().length > 0 ? { _tag: "Log", text: whole.stdout } : { _tag: "NoLog", reason: "the run has no failed step with a log" }
      : NO_LOG.test(whole.stderr) ? { _tag: "NoLog", reason: clipTo(plainText(whole.stderr.trim()), 200) } : yield* Effect.fail(new CommandFailed({ reason: "exited", command: commandLine(args), message: `exited with 1: ${clipTo(plainText(whole.stderr.trim()), 600)}` }))
    return log
  }, provided)

  const firstHead = Effect.fn("forge.first_head")(function* (repo: RepoName, pull: Pull) {
    const [owner = "", name = ""] = repo.split("/")
    const asked = ["gh", "api", "graphql", "-f", `query=${TIMELINE_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${pull.number}`]
    const answer = (yield* decoded(GhTimeline, asked, (yield* runWhole(asked)).stdout)).data.repository.pullRequest
    const timeline: PullTimeline = {
      opened: answer.createdAt,
      closed: Option.fromNullishOr(answer.closedAt),
      forcePushes: answer.timelineItems.nodes.map((node) => ({ at: node.createdAt, before: Option.fromNullishOr(node.beforeCommit?.oid) })),
    }
    const args = ["gh", "api", "--paginate", "--slurp", `repos/${repo}/actions/runs?event=pull_request&branch=${encodeURIComponent(pull.head.ref)}&per_page=100`]
    const runs = (yield* decoded(Schema.Array(GhBranchRuns), args, (yield* runWhole(args)).stdout)).flatMap((page) => page.workflow_runs)
    return yield* Option.match(firstHeadOf(runs.map((run) => ({ sha: run.head_sha, createdAt: run.created_at })), timeline, pull.commits), {
      onSome: Effect.succeed,
      onNone: () => Effect.fail(new ForgeUnreadable({ command: commandLine(args), message: `pull request #${pull.number} lists no commit, so it has no first head` })),
    })
  }, provided)

  const descriptionHistory = Effect.fn("forge.description_history")(function* (repo: RepoName, pull: Pull, at: CommitSha) {
    const [owner = "", name = ""] = repo.split("/")
    // The sha goes with -f, as a string: -F would read a sha of digits alone as a number.
    const args = ["gh", "api", "graphql", "-f", `query=${DESCRIPTION_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${pull.number}`, "-f", `sha=${at}`]
    const answer = (yield* decoded(GhDescription, args, (yield* runWhole(args)).stdout)).data.repository
    const history: DescriptionHistory = {
      // A commit the forge does not know has no time: no version is then read as the description of its time.
      committedAt: answer.object?.committedDate ?? "",
      edits: answer.pullRequest.userContentEdits.nodes.map((node) => ({ editedAt: node.editedAt, text: Option.fromNullishOr(node.diff) })),
      total: answer.pullRequest.userContentEdits.totalCount,
    }
    return history
  }, provided)

  const defaultBranch = Effect.fn("forge.default_branch")(function* (repo: RepoName) {
    const args = ["gh", "api", `repos/${repo}`]
    return (yield* decoded(GhRepo, args, (yield* runWhole(args)).stdout)).default_branch
  }, provided)

  return Forge.of({ pullRequest, ciRuns, firstHead, descriptionHistory, failedLog, defaultBranch })
}))
