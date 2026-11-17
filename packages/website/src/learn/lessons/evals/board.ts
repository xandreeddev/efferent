// Lesson 13's table of results, with no DOM: the trials a run writes, folded
// into what the page draws (`EvalsView`), which the tests read as the page
// does. A trial is written as it starts, as it ends and after each grade;
// the board keeps the latest of each by its id, so the table fills as trials
// end. A trial counts once every grader bound to its task has graded it:
// whether it passed is runnable.ts's `rowOf`, the row the comparison reads,
// so the table and the comparison never disagree. Each count of passes
// carries its Wilson interval, from the eval package's statistics.
import { Option } from "effect"
import type { DecisionTrial, EvaluationRun, Trial } from "@xandreed/evals"
import { wilsonInterval } from "@xandreed/evals/stats"

/** One trial as the table draws it on demand: how it went, each grade's reason, and its transcript. */
export interface TrialView {
  readonly id: string
  /** "sample 2: passed", "sample 2: failed", "sample 2: ran, not graded", "sample 2: running". */
  readonly label: string
  /** Each grade: its grader and what it said. */
  readonly grades: ReadonlyArray<string>
  /** What the trial ended with, when it did not complete: its reason. */
  readonly reason: string
  /** Each event of the trial's transcript: the record's kind and what it held. */
  readonly transcript: ReadonlyArray<string>
}

/** One task of one candidate: its line of the table, and its trials. */
export interface TaskView {
  readonly task: string
  readonly line: string
  readonly trials: ReadonlyArray<TrialView>
}

/** A gate's verdict for one candidate, as a line. */
export interface GateView {
  readonly passed: boolean
  readonly line: string
}

/** One candidate: its line over every task, each task's, and its gates once its run is graded. */
export interface CandidateView {
  readonly candidate: string
  readonly line: string
  readonly tasks: ReadonlyArray<TaskView>
  readonly gates: ReadonlyArray<GateView>
}

/** Everything the page draws of a run. */
export interface EvalsView {
  /** How far the run is, or how it ended. */
  readonly status: string
  readonly candidates: ReadonlyArray<CandidateView>
  /** What the gates decided for the suite: said once every candidate's run is graded. */
  readonly verdict: string
  /** Each candidate against Echo: said once the run is done. */
  readonly comparison: ReadonlyArray<string>
}

/** One candidate against the baseline, as `compareDecisionTrials` gives it: what the board draws of it. */
export interface Compared {
  readonly candidate: string
  readonly attempts: number
  readonly successes: number
  readonly regressions: ReadonlyArray<string>
  /** Trials that did not complete: counted in `attempts`, never a success and never a regression. */
  readonly infrastructure: number
}

/** A share as the table writes it: at most two decimals, and no trailing zero ("0.57", "1"). */
export const share = (value: number): string => String(Number(value.toFixed(2)))

/** The bounds a finding says its gate held the metric to, as words: " at least 0.8", " at most 1", " from 0.5 to 0.9"; none for a finding that does not say. */
export const heldTo = (finding: { readonly minimum?: number; readonly maximum?: number }): string =>
  finding.minimum !== undefined && finding.maximum !== undefined ? ` from ${share(finding.minimum)} to ${share(finding.maximum)}`
    : finding.minimum !== undefined ? ` at least ${share(finding.minimum)}`
      : finding.maximum !== undefined ? ` at most ${share(finding.maximum)}` : ""

/** Passes of a count, with the interval they leave: "4 of 5 passed (0.38 to 0.96)". */
export const passesLine = (passes: number, of: number): string => {
  const interval = wilsonInterval(passes, of)
  return `${passes} of ${of} passed (${share(interval.low)} to ${share(interval.high)})`
}

/** Whether a trial ran to its end: it completed, or failed. One still running, or cancelled by a stop, did not. */
const ran = (trial: Trial): boolean => trial.status === "completed" || trial.status === "error"

/** Whether every grader bound to a trial's task has graded it. */
const graded = (trial: Trial): boolean => trial.status !== "running" && trial.grades.length === trial.task.graders.length

/** A value of a transcript event, on one line and short. */
const clipped = (value: unknown): string => {
  const text = JSON.stringify(value) ?? "null"
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

/** How a run ended, as the board says it. */
type Ending = { readonly _tag: "Running" } | { readonly _tag: "Done" } | { readonly _tag: "Stopped" } | { readonly _tag: "Failed"; readonly message: string }

export class EvalsBoard {
  private readonly trials = new Map<string, Trial>()
  private runs: ReadonlyArray<EvaluationRun> = []
  private compared: ReadonlyArray<Compared> = []
  private ending: Ending = { _tag: "Running" }

  /**
   * A board for a run of `tasks`, each run `repetitions` times for each of `candidates`, in that order. `rowOf` is
   * runnable.ts's: a trial as the comparison reads it, whether it passed included; none when it is no row.
   */
  constructor(
    private readonly candidates: ReadonlyArray<string>,
    private readonly tasks: ReadonlyArray<string>,
    private readonly repetitions: number,
    private readonly rowOf: (trial: Trial) => Option.Option<DecisionTrial>,
  ) {}

  /** A trial as the run wrote it: the latest of each id is kept. */
  hear(trial: Trial): void {
    this.trials.set(trial.id, trial)
  }

  /** The run is over: each candidate's run, with its gates, and the comparison with Echo. */
  done(runs: ReadonlyArray<EvaluationRun>, compared: ReadonlyArray<Compared>): void {
    this.runs = runs
    this.compared = compared
    this.ending = { _tag: "Done" }
  }

  /** The run was stopped: what it finished stays. */
  stopped(): void {
    this.ending = { _tag: "Stopped" }
  }

  /** The run failed, in these words: what it finished stays. */
  failed(message: string): void {
    this.ending = { _tag: "Failed", message }
  }

  /** How many trials the run holds in all. */
  get expected(): number {
    return this.candidates.length * this.tasks.length * this.repetitions
  }

  /** How many trials ran to their end. */
  get ended(): number {
    return [...this.trials.values()].filter(ran).length
  }

  /** Whether a trial passed, by runnable.ts's row; none while it is not graded. */
  private passed(trial: Trial): Option.Option<boolean> {
    return graded(trial) ? Option.map(this.rowOf(trial), (row) => row.status === "completed" && row.passed) : Option.none()
  }

  private trialView(trial: Trial): TrialView {
    const label = Option.match(this.passed(trial), {
      onSome: (passed) => (passed ? "passed" : Option.exists(this.rowOf(trial), (row) => row.status === "infrastructure") ? "error" : "failed"),
      onNone: () => (trial.status === "running" || trial.status === "cancelled" ? trial.status : "ran, not graded"),
    })
    return {
      id: trial.id,
      label: `sample ${trial.sample}: ${label}`,
      grades: trial.grades.map((grade) => `${grade.grader}@${grade.version}: ${grade.reason}`),
      reason: trial.status === "completed" || trial.status === "running" ? "" : `${trial.status}: ${trial.reason}`,
      transcript: trial.transcript.map((event) => `${event.kind} ${clipped(event.data)}`),
    }
  }

  /**
   * The line of a set of trials: passes of the count once each is graded; before that, how many ran and, of those
   * graded (each trial is graded as it ends), how many passed.
   */
  private line(trials: ReadonlyArray<Trial>, of: number): string {
    const verdicts = trials.flatMap((trial) => Option.toArray(this.passed(trial)))
    const passes = verdicts.filter((passed) => passed).length
    if (verdicts.length === of) return passesLine(passes, of)
    const count = trials.filter(ran).length
    const running = this.ending._tag === "Running"
    if (verdicts.length > 0) return `ran ${count} of ${of}, ${passes} of ${verdicts.length} graded passed${running ? " so far" : ""}`
    return count === 0 && running ? "waiting" : `ran ${count} of ${of}${running ? "" : ", not graded"}`
  }

  private gatesOf(candidate: string): ReadonlyArray<GateView> {
    return this.runs.flatMap((run) => run.gates).filter((gate) => gate.candidate === candidate).map((gate) => ({
      passed: gate.passed,
      line: `${gate.passed ? "✓" : "✗"} ${gate.grader} ${gate.metric}${heldTo(gate)}, ${gate.mode}: ${Option.match(gate.value, { onNone: () => "not measured", onSome: (value) => `measured ${share(value)}` })} (${gate.reason})`,
    }))
  }

  /** What the gates decided for the suite: a candidate that fails a blocking gate blocks it. */
  private verdict(): string {
    if (this.ending._tag !== "Done") return ""
    const blocking = this.runs.flatMap((run) => run.gates).filter((gate) => gate.mode === "blocking" && !gate.passed)
    const names = [...new Set(blocking.map((gate) => gate.candidate))]
    return names.length === 0 ? "Every candidate passed every blocking gate." : `The suite is blocked: ${names.join(", ")} failed a blocking gate.`
  }

  private comparison(): ReadonlyArray<string> {
    return this.compared.map((one) => {
      const regressions = [...new Set(one.regressions)]
      const errors = one.infrastructure === 0 ? "" : ` (${one.infrastructure} ${one.infrastructure === 1 ? "error" : "errors"}, no finding about the model)`
      const head = `${one.candidate}${one.candidate === "echo" ? " (the baseline)" : ""}: ${one.successes} of ${one.attempts} passed${errors}`
      return one.candidate === "echo" ? head : `${head}; ${regressions.length === 0 ? "no regression against Echo" : `regressions against Echo: ${regressions.join(", ")}`}`
    })
  }

  private status(): string {
    const ran = `${this.ended} of ${this.expected} trials ran`
    switch (this.ending._tag) {
      case "Running": return `${ran}.`
      case "Done": return `Done: ${ran}, each graded.`
      case "Stopped": return `Stopped: ${ran}. Trials are graded as they end, and one whose grading was cut short is not graded. A candidate cut short has no gates, and there is no comparison.`
      case "Failed": return `The evals did not run to the end: ${this.ending.message}`
    }
  }

  view(): EvalsView {
    const all = [...this.trials.values()]
    return {
      status: this.status(),
      candidates: this.candidates.map((candidate) => {
        const own = all.filter((trial) => trial.candidate.id === candidate)
        return {
          candidate,
          line: this.line(own, this.tasks.length * this.repetitions),
          tasks: this.tasks.map((task) => {
            const trials = own.filter((trial) => trial.task.id === task).toSorted((a, b) => a.sample - b.sample)
            return { task, line: this.line(trials, this.repetitions), trials: trials.map((trial) => this.trialView(trial)) }
          }),
          gates: this.gatesOf(candidate),
        }
      }),
      verdict: this.verdict(),
      comparison: this.comparison(),
    }
  }
}
