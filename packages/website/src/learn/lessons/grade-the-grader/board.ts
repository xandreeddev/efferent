// Lesson 19's table, with no DOM: the checks a run writes, folded into what
// the page draws (`GradersView`), which the tests read as the page does. A
// check is one grader on one labelled answer. The run writes it as it
// starts, as it ends and once it is graded; calibration.ts's `rowOf` makes
// a row of it once it is graded, and the board keeps the row by grader and
// case. Each grader's line counts its rows that agree with their label, and
// names its false passes, its false fails and the cases it gave no grade.
// The board names no part of the eval package: it reads rows, held to the
// page's own schema.
import { Option, Schema } from "effect"

/** One row, as calibration.ts's `rowOf` makes it: a grader's verdict on one case, beside the label. */
export const Row = Schema.Struct({
  grader: Schema.String,
  id: Schema.String,
  label: Schema.Boolean,
  verdict: Schema.Literals(["yes", "no", "no grade"]),
  agrees: Schema.Boolean,
  falsePass: Schema.Boolean,
  falseFail: Schema.Boolean,
  reason: Schema.String,
})
export type Row = typeof Row.Type

/** One labelled answer as the table's row heads it. */
export interface Labelled {
  readonly id: string
  readonly question: string
  readonly answer: string
  readonly label: boolean
}

/** One grader's verdict on one case, as a cell of the table: its mark, and its reason on demand. */
export interface CellView {
  readonly grader: string
  /** "yes ✓", "yes ✗", "no ✓", "no ✗", "no grade ✗", or "not checked". */
  readonly mark: string
  /** Whether the verdict agrees with the label; none while the case is not checked. */
  readonly agrees: Option.Option<boolean>
  readonly reason: string
}

/** One labelled answer: its id, what was asked and answered, its label, and each grader's cell. */
export interface CaseView {
  readonly id: string
  readonly text: string
  /** "right" or "wrong", as the person labelled it. */
  readonly label: string
  readonly cells: ReadonlyArray<CellView>
}

/** One grader's line over every case. */
export interface GraderView {
  readonly grader: string
  readonly line: string
}

/** Everything the page draws of a check of the graders. */
export interface GradersView {
  /** How far the run is, or how it ended. */
  readonly status: string
  readonly graders: ReadonlyArray<GraderView>
  readonly cases: ReadonlyArray<CaseView>
  /** Who answered for Jev, and what a press costs with a key. */
  readonly judge: string
}

/** A list of case ids as words: "5, 6, 7, 8", or "none". */
const listed = (ids: ReadonlyArray<string>): string => (ids.length === 0 ? "none" : ids.join(", "))

/** A grader's line once every case is checked: how many agree, its false passes, its false fails, and any case it gave no grade. */
export const graderLine = (rows: ReadonlyArray<Row>, of: number): string => {
  const ids = (keep: (row: Row) => boolean) => rows.filter(keep).map((row) => row.id)
  const ungraded = ids((row) => row.verdict === "no grade")
  return `agrees with ${rows.filter((row) => row.agrees).length} of ${of}; false passes: ${listed(ids((row) => row.falsePass))}; false fails: ${listed(ids((row) => row.falseFail))}${ungraded.length === 0 ? "" : `; no grade: ${listed(ungraded)}`}`
}

export class GradersBoard {
  private readonly rows = new Map<string, Row>()
  private ending: Option.Option<string> = Option.none()

  /**
   * `graders` and `cases` are the table's columns and rows, in the files' order; `judge` the line under it; `rowOf`
   * calibration.ts's, given each check the run writes: the row it makes, or none while it is not graded.
   */
  constructor(
    private readonly graders: ReadonlyArray<string>,
    private readonly cases: ReadonlyArray<Labelled>,
    private readonly judge: string,
    private readonly rowOf: (written: unknown) => Option.Option<Row>,
  ) {}

  /** A check written by the run: its row, once it is graded, is kept by grader and case. */
  hear(written: unknown): void {
    Option.map(this.rowOf(written), (row) => this.rows.set(`${row.grader}/${row.id}`, row))
  }

  /** The run is over. */
  done(): void { this.ending = Option.some("done") }

  /** The run was stopped where it was. */
  stopped(): void { this.ending = Option.some("stopped") }

  /** The run failed, in these words. */
  failed(words: string): void { this.ending = Option.some(`failed: ${words}`) }

  private rowsOf(grader: string): ReadonlyArray<Row> {
    return this.cases.flatMap((one) => Option.toArray(Option.fromNullishOr(this.rows.get(`${grader}/${one.id}`))))
  }

  view(): GradersView {
    const total = this.graders.length * this.cases.length
    const graded = this.graders.reduce((sum, grader) => sum + this.rowsOf(grader).length, 0)
    const ending = Option.getOrElse(this.ending, () => "")
    const status = ending === "done" ? `Done: ${graded} of ${total} checks graded.`
      : ending === "stopped" ? `Stopped: ${graded} of ${total} checks graded. A grader cut short says how many cases it checked.`
        : ending.startsWith("failed: ") ? `The check did not run to the end: ${ending.slice("failed: ".length)}`
          : `Checking: ${graded} of ${total} checks graded.`
    return {
      status,
      graders: this.graders.map((grader) => {
        const rows = this.rowsOf(grader)
        return {
          grader,
          line: rows.length === this.cases.length ? graderLine(rows, this.cases.length)
            : rows.length === 0 ? "not checked yet"
              : `checked ${rows.length} of ${this.cases.length} so far, agrees with ${rows.filter((row) => row.agrees).length}`,
        }
      }),
      cases: this.cases.map((one) => ({
        id: one.id,
        text: `${one.question} ${one.answer}`,
        label: one.label ? "right" : "wrong",
        cells: this.graders.map((grader) => Option.match(Option.fromNullishOr(this.rows.get(`${grader}/${one.id}`)), {
          onNone: (): CellView => ({ grader, mark: "not checked", agrees: Option.none(), reason: "" }),
          onSome: (row): CellView => ({ grader, mark: `${row.verdict} ${row.agrees ? "✓" : "✗"}`, agrees: Option.some(row.agrees), reason: row.reason }),
        })),
      })),
      judge: this.judge,
    }
  }
}
