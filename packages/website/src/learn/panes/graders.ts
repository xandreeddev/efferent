// Lesson 19's table: draws what the board gives (`GradersView`), as text
// nodes. Each grader's line, then a row for each labelled answer: what was
// asked and answered, the label, and a cell for each grader, its verdict
// against the label, which opens on demand to the grader's reason. Under it,
// who answered for Jev. The table is drawn again each time a check is
// written; a cell opened stays open.
import { Option } from "effect"
import type { GradersView } from "../lessons/grade-the-grader/board.ts"

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag)
  if (className !== "") made.className = className
  if (text !== undefined) made.textContent = text
  return made
}

export interface GradersPane {
  /** Draw the board's view. */
  readonly draw: (view: GradersView) => void
  /** Say one line in place of the table: why the check did not run. */
  readonly say: (text: string) => void
}

export const mountGraders = (host: HTMLElement): GradersPane => {
  /** The cells opened by the reader, by grader and case, so a redraw keeps them open. */
  const open = new Set<string>()
  return {
    say: (text) => {
      host.replaceChildren(el("p", "evals-status", text))
      host.dataset.state = "failed"
      host.hidden = false
    },
    draw: (view) => {
      const lines = el("ul", "graders-lines")
      lines.append(...view.graders.map((grader) => {
        const line = el("li", "")
        line.append(el("strong", "", grader.grader), ` ${grader.line}`)
        return line
      }))
      const table = el("table", "graders-table")
      const head = el("tr", "")
      // A grader's name may break after a hyphen ("asked-" over "thrice"), so its column is as narrow as its marks.
      head.append(el("th", "", "label"), ...view.graders.map((grader) => el("th", "", grader.grader.replace(/-/g, "-\u200b"))))
      table.append(el("thead", ""), el("tbody", ""))
      table.tHead?.append(head)
      // Each case is two rows: its question and answer across the table, then its label and each grader's mark under
      // it, so the graders' columns fit a narrow column of the page.
      table.tBodies[0]?.append(...view.cases.flatMap((one) => {
        const said = el("tr", "graders-case")
        const asked = el("th", "")
        asked.colSpan = view.graders.length + 1
        asked.scope = "rowgroup"
        asked.append(el("strong", "", `${one.id}. `), one.text)
        said.append(asked)
        const row = el("tr", "")
        row.append(el("td", "", one.label))
        row.append(...one.cells.map((cell) => {
          const td = el("td", "")
          Option.map(cell.agrees, (agrees) => { td.dataset.agrees = String(agrees) })
          if (cell.reason === "") {
            td.textContent = cell.mark
            return td
          }
          const key = `${cell.grader}/${one.id}`
          const details = el("details", "")
          details.open = open.has(key)
          details.addEventListener("toggle", () => { if (details.open) open.add(key); else open.delete(key) })
          details.append(el("summary", "", cell.mark), el("p", "", cell.reason))
          td.append(details)
          return td
        }))
        return [said, row]
      }))
      const scroll = el("div", "graders-scroll")
      scroll.append(table)
      host.replaceChildren(el("p", "evals-status", view.status), lines, scroll, el("p", "evals-status", view.judge))
      delete host.dataset.state
      host.hidden = false
    },
  }
}
