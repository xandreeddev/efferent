import { Option } from "effect"
import type { FactoryRun } from "@xandreed/foundry"
import type { ConversationSummary, SpecDoc } from "@xandreed/engine"
import type { ProviderStatus } from "./loginFlow.js"

/**
 * The workspace dashboard's view model — what a persistent smith session
 * shows between runs: the specs on file, the forge history, and the lessons
 * the memory would brief the next run with. Pure (unit-tested without
 * Solid); the runtime folds fresh reads into it after every run.
 */

export interface SpecLine {
  readonly slug: string
  readonly status: "draft" | "locked"
  readonly goal: string
}

export interface RunLine {
  readonly text: string
  readonly accepted: boolean
}

export interface ProviderChip {
  readonly name: string
  /** `None` = not set up (dim); `Some` = the credential kind tag (accent). */
  readonly tag: Option.Option<string>
}

export interface SessionLine {
  readonly id: string
  readonly label: string
  readonly ageMinutes: number
}

export interface WorkspaceView {
  readonly specs: ReadonlyArray<SpecLine>
  readonly runs: ReadonlyArray<RunLine>
  readonly lessons: ReadonlyArray<string>
  readonly providers: ReadonlyArray<ProviderChip>
  readonly sessions: ReadonlyArray<SessionLine>
  /** No provider has a credential — the workspace can't run a model yet. */
  readonly unconfigured: boolean
}

export const emptyWorkspace: WorkspaceView = {
  specs: [],
  runs: [],
  lessons: [],
  providers: [],
  sessions: [],
  unconfigured: false,
}

const RUNS_SHOWN = 6
const SESSIONS_SHOWN = 5

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

export const runLine = (run: FactoryRun): RunLine => {
  const gatesFailed = run.attempts
    .flatMap((a) => a.report.verdicts)
    .filter((v) => v._tag === "fail").length
  // An at-rest `in-flight` artifact is a run that was KILLED mid-work (or is
  // still running in another session) — visible forensics, not an error.
  const outcome =
    run.outcome._tag === "accepted"
      ? `✓ accepted (attempt ${run.outcome.attempt})`
      : run.outcome._tag === "rejected"
        ? `✗ rejected — ${run.outcome.reason}`
        : `◌ in flight — ${run.attempts.length} attempt(s) recorded`
  const rejects = gatesFailed > 0 ? ` · ${gatesFailed} gate reject(s)` : ""
  return {
    text: `${outcome} · ${clip(run.spec.goal, 48)}${rejects}`,
    accepted: run.outcome._tag === "accepted",
  }
}

/** Fold the workspace reads into the dashboard model: specs as listed,
 *  runs newest-first (capped), the lessons section split into lines. */
const credentialWord = (kind: string): string =>
  kind === "oauth" ? "subscription" : kind === "api_key" ? "api key" : "local"

export const providerChips = (
  statuses: ReadonlyArray<ProviderStatus>,
): ReadonlyArray<ProviderChip> =>
  statuses.map((s) => ({
    name: s.provider,
    tag: Option.map(s.configured, credentialWord),
  }))

export const sessionLines = (
  summaries: ReadonlyArray<ConversationSummary>,
  now: number,
): ReadonlyArray<SessionLine> =>
  [...summaries]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, SESSIONS_SHOWN)
    .map((s) => ({
      id: String(s.id),
      label: clip(
        Option.getOrElse(
          Option.orElse(s.title, () => s.firstPrompt),
          () => "(empty session)",
        ),
        56,
      ),
      ageMinutes: Math.max(0, Math.round((now - s.createdAt) / 60_000)),
    }))

export const workspaceView = (
  specs: ReadonlyArray<SpecDoc>,
  runs: ReadonlyArray<FactoryRun>,
  lessons: Option.Option<string>,
  statuses: ReadonlyArray<ProviderStatus> = [],
  sessions: ReadonlyArray<ConversationSummary> = [],
  now = 0,
): WorkspaceView => ({
  providers: providerChips(statuses),
  sessions: sessionLines(sessions, now),
  unconfigured: statuses.length > 0 && statuses.every((s) => Option.isNone(s.configured)),
  specs: specs.map((doc) => ({
    slug: String(doc.slug),
    status: doc.status,
    goal: clip(doc.goal, 60),
  })),
  runs: [...runs].reverse().slice(0, RUNS_SHOWN).map(runLine),
  lessons: Option.match(lessons, {
    onNone: () => [],
    onSome: (text) =>
      text
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => clip(line.slice(2), 100)),
  }),
})
