import { Option } from "effect"
import type { FactoryRun } from "@xandreed/foundry"
import type { SpecDoc } from "@xandreed/engine"

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

export interface WorkspaceView {
  readonly specs: ReadonlyArray<SpecLine>
  readonly runs: ReadonlyArray<RunLine>
  readonly lessons: ReadonlyArray<string>
}

export const emptyWorkspace: WorkspaceView = { specs: [], runs: [], lessons: [] }

const RUNS_SHOWN = 6

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

export const runLine = (run: FactoryRun): RunLine => {
  const gatesFailed = run.attempts
    .flatMap((a) => a.report.verdicts)
    .filter((v) => v._tag === "fail").length
  const outcome =
    run.outcome._tag === "accepted"
      ? `✓ accepted (attempt ${run.outcome.attempt})`
      : `✗ rejected — ${run.outcome.reason}`
  const rejects = gatesFailed > 0 ? ` · ${gatesFailed} gate reject(s)` : ""
  return {
    text: `${outcome} · ${clip(run.spec.goal, 48)}${rejects}`,
    accepted: run.outcome._tag === "accepted",
  }
}

/** Fold the workspace reads into the dashboard model: specs as listed,
 *  runs newest-first (capped), the lessons section split into lines. */
export const workspaceView = (
  specs: ReadonlyArray<SpecDoc>,
  runs: ReadonlyArray<FactoryRun>,
  lessons: Option.Option<string>,
): WorkspaceView => ({
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
