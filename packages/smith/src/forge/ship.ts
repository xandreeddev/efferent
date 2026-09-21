import { Array as Arr, Effect, Option } from "effect"
import type { FactoryRun } from "@xandreed/foundry"
import { Shell } from "@xandreed/core"
import type { SpecDoc } from "@xandreed/core"
import type { SmithEvent } from "../domain/SmithEvent.js"

/**
 * The SHIP step — the human-invoked follow-through on an ACCEPTED forge run:
 * branch → stage → commit → push → PR, through the engine Shell port in the
 * workspace. Every step publishes a `ship_step` event (never silent), every
 * non-zero exit STOPS the sequence with the stderr in the pane, and nothing
 * here is destructive (no force, no reset, no checkout of existing branches).
 * The workspace's own git identity signs the commit — smith adds no trailers.
 *
 * Every step is IDEMPOTENT, so a stopped ship re-runs cleanly once the
 * environment is fixed: the branch it already checked out is kept, nothing
 * new to stage reuses the commit it already made, an existing PR is reused.
 * (Live-caught: a failed push could never be retried — the re-run died on
 * "nothing to commit" before reaching the push again.)
 */

const SUBJECT_CAP = 72
const DETAIL_CAP = 300
const STEP_TIMEOUT_MS = 120_000

/**
 * The harness's OWN state never rides a ship: the conversation db (+ WAL /
 * SHM), logs, the memory ledger, the profile draft, the local model
 * selection, and the run artifacts. Specs DO ship — they are the change's
 * provenance. (Live-caught: a bare `git add -A` staged smith.db into a PR.)
 */
export const HARNESS_STATE_PATHSPECS: ReadonlyArray<string> = [
  ".efferent/smith.db",
  ".efferent/smith.db-wal",
  ".efferent/smith.db-shm",
  ".efferent/logs",
  ".efferent/memory",
  ".efferent/profile-draft",
  ".efferent/config.json",
  ".foundry/runs",
]

export interface ShipPlan {
  readonly cwd: string
  /** Created only when the workspace sits on main/master. */
  readonly branch: string
  readonly subject: string
  readonly commitBody: string
  readonly prBody: string
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

const firstLine = (text: string): string => text.split("\n")[0] ?? text

const lastLine = (text: string): string => text.split("\n").at(-1)?.trim() ?? ""

/** POSIX single-quote escaping — the only quoting `bash -c` needs here. */
const sq = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`

/** The whole tree minus the harness's own state (see {@link HARNESS_STATE_PATHSPECS}). */
export const stageCommand = (): string =>
  `git add -A -- . ${HARNESS_STATE_PATHSPECS.map((path) => sq(`:(exclude)${path}`)).join(" ")}`

/** The plan is pure: everything the ship needs, derived from the run's own
 *  artifact (the last attempt's verdicts ARE the green gates). */
export const renderShipPlan = (
  cwd: string,
  doc: Option.Option<SpecDoc>,
  run: FactoryRun,
): ShipPlan => {
  const slug = Option.match(doc, {
    onNone: () => `run-${String(run.id).slice(0, 8)}`,
    onSome: (d) => String(d.slug),
  })
  const subject = clip(firstLine(run.spec.goal), SUBJECT_CAP)
  const gates = Arr.lastNonEmpty(run.attempts).report.verdicts.map((v) => String(v.gate))
  const acceptance =
    run.spec.acceptance.length === 0
      ? ""
      : `\n\n## Acceptance\n${run.spec.acceptance.map((a) => `- ${a}`).join("\n")}`
  return {
    cwd,
    branch: `smith/${slug}`,
    subject,
    commitBody: `smith forge run ${String(run.id)} — gates green: ${gates.join(", ")}`,
    prBody: `## What\n\n${run.spec.goal}${acceptance}\n\n## Verification\n\nAccepted by the forge gate pipeline (${gates.join(" → ")}) after ${run.attempts.length} attempt(s). Artifact: \`.foundry/runs/${String(run.id)}.json\`.`,
  }
}

interface StepResult {
  readonly ok: boolean
  readonly detail: string
}

/**
 * Run the ship sequence. Returns the PR URL on full success, `None` when any
 * step stopped the sequence — the events carry the why.
 */
export const runShip = (
  plan: ShipPlan,
  publish: (event: SmithEvent) => Effect.Effect<void>,
): Effect.Effect<Option.Option<string>, never, Shell> =>
  Effect.gen(function* () {
    const shell = yield* Shell

    /** A silent PROBE — a question about the workspace, never a step on the pane. */
    const probe = (command: string): Effect.Effect<StepResult> =>
      shell.exec(command, { cwd: plan.cwd, timeoutMs: STEP_TIMEOUT_MS }).pipe(
        Effect.map((result) => ({
          ok: result.exitCode === 0,
          detail:
            result.exitCode === 0
              ? result.stdout.trim()
              : result.stderr.trim().length > 0
                ? result.stderr.trim()
                : result.stdout.trim(),
        })),
        Effect.catchAll((error) => Effect.succeed({ ok: false, detail: error.message })),
      )

    const report = (step: string, result: StepResult): Effect.Effect<StepResult> =>
      publish({
        type: "ship_step",
        step,
        ok: result.ok,
        detail: clip(result.detail, DETAIL_CAP),
      }).pipe(Effect.as(result))

    /** A published STEP — its exit code is the verdict. */
    const exec = (step: string, command: string): Effect.Effect<StepResult> =>
      probe(command).pipe(Effect.flatMap((result) => report(step, result)))

    const head = yield* exec("branch", "git rev-parse --abbrev-ref HEAD")
    if (!head.ok || head.detail.length === 0) return Option.none<string>()

    const onDefault = head.detail === "main" || head.detail === "master"
    const branch = onDefault ? plan.branch : head.detail
    if (onDefault) {
      const created = yield* exec("checkout", `git checkout -b ${sq(branch)}`)
      if (!created.ok) return Option.none<string>()
    }

    const staged = yield* exec("stage", stageCommand())
    if (!staged.ok) return Option.none<string>()

    // `git diff --cached --quiet` exits 0 when the index matches HEAD: a
    // re-run after a failed push has nothing new and reuses the commit it
    // already made. A probe that cannot run reads as "something pending" —
    // the commit step then surfaces the real error.
    const pending = yield* probe("git diff --cached --quiet")
    const committed = pending.ok
      ? yield* report("commit", {
          ok: true,
          detail: "nothing new to commit — reusing the branch's existing commit",
        })
      : yield* exec("commit", `git commit -m ${sq(plan.subject)} -m ${sq(plan.commitBody)}`)
    if (!committed.ok) return Option.none<string>()

    const pushed = yield* exec("push", `git push -u origin ${sq(branch)}`)
    if (!pushed.ok) return Option.none<string>()

    // A PR already open for this branch (a re-run after `gh` failed, or the
    // human opened one by hand) is the deliverable — never a second one.
    const existing = yield* probe(`gh pr view ${sq(branch)} --json url --jq .url`)
    const existingUrl = existing.ok ? lastLine(existing.detail) : ""
    if (existingUrl.startsWith("http")) {
      yield* report("pr", { ok: true, detail: `existing PR reused: ${existingUrl}` })
      return Option.some(existingUrl)
    }

    const pr = yield* exec(
      "pr",
      `gh pr create --head ${sq(branch)} --title ${sq(plan.subject)} --body ${sq(plan.prBody)}`,
    )
    if (!pr.ok) return Option.none<string>()
    const url = lastLine(pr.detail)
    return url.length > 0 ? Option.some(url) : Option.none<string>()
  })
