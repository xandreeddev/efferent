// Lesson 13's table of results: draws what the board gives (`EvalsView`),
// as text nodes. Each candidate is a block: its line over every task, a row
// for each task, each task's trials on demand (each trial's grades and its
// transcript), and its gates. Under them, the suite's verdict and the
// comparison with Echo. The table is drawn again each time a trial is
// written; a trial or a task opened stays open.
import type { EvalsView } from "../lessons/evals/board.ts"

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag)
  if (className !== "") made.className = className
  if (text !== undefined) made.textContent = text
  return made
}

export interface EvalsPane {
  /** Draw the board's view. */
  readonly draw: (view: EvalsView) => void
  /** Say one line in place of the table: why the evals did not run. */
  readonly say: (text: string) => void
}

export const mountEvals = (host: HTMLElement): EvalsPane => {
  /** The `<details>` opened by the reader, by key, so a redraw keeps them open. */
  const open = new Set<string>()
  const details = (key: string, summary: string, className: string): HTMLDetailsElement => {
    const made = el("details", className)
    made.open = open.has(key)
    made.addEventListener("toggle", () => { if (made.open) open.add(key); else open.delete(key) })
    made.append(el("summary", "", summary))
    return made
  }
  return {
    say: (text) => {
      host.replaceChildren(el("p", "evals-status", text))
      host.dataset.state = "failed"
      host.hidden = false
    },
    draw: (view) => {
      const parts: Array<HTMLElement> = [el("p", "evals-status", view.status)]
      for (const candidate of view.candidates) {
        const block = el("section", "evals-candidate")
        const head = el("p", "evals-head")
        head.append(el("strong", "", candidate.candidate), ` ${candidate.line}`)
        block.append(head)
        for (const task of candidate.tasks) {
          const row = details(`${candidate.candidate}/${task.task}`, `${task.task}: ${task.line}`, "evals-task")
          for (const trial of task.trials) {
            const one = details(trial.id, trial.label, "evals-trial")
            const grades = el("ul", "evals-grades")
            grades.append(...trial.grades.map((grade) => el("li", "", grade)), ...(trial.reason === "" ? [] : [el("li", "", trial.reason)]))
            one.append(grades, el("pre", "evals-transcript", trial.transcript.join("\n")))
            row.append(one)
          }
          block.append(row)
        }
        if (candidate.gates.length > 0) {
          const gates = el("ul", "learn-kit")
          gates.append(...candidate.gates.map((gate) => {
            const line = el("li", "", gate.line)
            line.dataset.state = gate.passed ? "passed" : "failed"
            return line
          }))
          block.append(gates)
        }
        parts.push(block)
      }
      if (view.verdict !== "") parts.push(el("p", "evals-verdict", view.verdict))
      if (view.comparison.length > 0) {
        const compared = el("ul", "evals-comparison")
        compared.append(...view.comparison.map((line) => el("li", "", line)))
        parts.push(el("p", "evals-head", "Compared with Echo:"), compared)
      }
      host.replaceChildren(...parts)
      delete host.dataset.state
      host.hidden = false
    },
  }
}
