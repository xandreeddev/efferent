/**
 * A reusable, pure select-box overlay — a navigable list with a type-to-filter
 * line and a windowed view that follows the highlight (pi's provider/model
 * selector UX). Generalises the slash-palette pattern (`slashPalette.ts`) into
 * something `:model` (and future pickers) can drive. Pure: state + reducers +
 * an `OverlayLine[]` renderer composited by `render.ts`, like `modal.ts`.
 */

import type { OverlayLine } from "./modal.js"
import { ansi, padRight, truncate, visibleLength } from "./terminal.js"

export interface SelectOption<T> {
  readonly value: T
  /** Display text (also what the filter matches against). */
  readonly label: string
  /** Marked with a `◀ active` tag (e.g. the current model). */
  readonly active?: boolean
}

export interface SelectState<T> {
  readonly title: string
  readonly all: ReadonlyArray<SelectOption<T>>
  readonly filter: string
  /** `all` narrowed by `filter` (case-insensitive substring on `label`). */
  readonly matches: ReadonlyArray<SelectOption<T>>
  /** Index into `matches`. */
  readonly selected: number
}

const narrow = <T>(
  all: ReadonlyArray<SelectOption<T>>,
  filter: string,
): ReadonlyArray<SelectOption<T>> => {
  const q = filter.trim().toLowerCase()
  return q.length === 0 ? all : all.filter((o) => o.label.toLowerCase().includes(q))
}

export const openSelect = <T>(
  title: string,
  options: ReadonlyArray<SelectOption<T>>,
): SelectState<T> => {
  const activeIdx = options.findIndex((o) => o.active === true)
  return {
    title,
    all: options,
    filter: "",
    matches: options,
    selected: activeIdx >= 0 ? activeIdx : 0,
  }
}

export const moveSelect = <T>(
  state: SelectState<T>,
  dir: "up" | "down",
): SelectState<T> => {
  const n = state.matches.length
  if (n === 0) return state
  const selected =
    dir === "up"
      ? (state.selected - 1 + n) % n
      : (state.selected + 1) % n
  return { ...state, selected }
}

const reFilter = <T>(state: SelectState<T>, filter: string): SelectState<T> => {
  const matches = narrow(state.all, filter)
  const selected = matches.length === 0 ? 0 : Math.min(state.selected, matches.length - 1)
  return { ...state, filter, matches, selected }
}

export const filterAppend = <T>(state: SelectState<T>, ch: string): SelectState<T> =>
  reFilter(state, state.filter + ch)

export const filterBackspace = <T>(state: SelectState<T>): SelectState<T> =>
  reFilter(state, state.filter.slice(0, -1))

export const selectedValue = <T>(state: SelectState<T>): T | undefined =>
  state.matches[state.selected]?.value

/**
 * Render the select box as a centered overlay. `maxRows` bounds the list
 * window (it follows the selection when there are more matches than fit).
 */
export const renderSelectBox = <T>(
  state: SelectState<T>,
  termRows: number,
  termCols: number,
  maxRows = 12,
): OverlayLine[] => {
  const boxWidth = Math.min(76, Math.max(40, termCols - 6))
  const innerWidth = boxWidth - 4
  const n = state.matches.length
  const listRows = Math.min(maxRows, Math.max(1, n))
  // title + filter + sep + list + counter, framed (2 borders)
  const totalLines = listRows + 6
  const top = Math.max(1, Math.floor((termRows - totalLines) / 2))
  const left = Math.max(1, Math.floor((termCols - boxWidth) / 2))
  const horiz = "─".repeat(boxWidth - 2)

  const fill = (s: string): string =>
    `${ansi.bgDarkGray}${ansi.fgWhite}${padRight(s, boxWidth)}${ansi.reset}`
  const span = (style: string, text: string): string =>
    `${style}${text}${ansi.reset}${ansi.bgDarkGray}${ansi.fgWhite}`
  const row = (inner: string): string => fill(`│ ${padRight(inner, innerWidth)} │`)

  // Window that follows the selection.
  let start = state.selected - Math.floor(listRows / 2)
  start = Math.max(0, Math.min(start, Math.max(0, n - listRows)))
  const moreAbove = start > 0
  const moreBelow = start + listRows < n

  const out: OverlayLine[] = []
  let r = top
  const emit = (content: string) => {
    out.push({ row: r, col: left, content })
    r += 1
  }

  emit(fill(`╭${horiz}╮`))
  emit(row(span(ansi.fgBrightCyan + ansi.bold, truncate(state.title, innerWidth))))
  emit(
    row(
      `${ansi.fgGray}/ ${ansi.reset}${ansi.bgDarkGray}${ansi.fgWhite}${truncate(
        state.filter,
        innerWidth - 2,
      )}${span(ansi.fgBrightGreen, "█")}`,
    ),
  )
  emit(fill(`├${horiz}┤`))
  if (n === 0) {
    emit(row(span(ansi.fgGray, "(no matches)")))
  } else {
    for (let j = 0; j < listRows; j++) {
      const idx = start + j
      const opt = state.matches[idx]!
      const marker =
        idx === state.selected
          ? span(ansi.fgBrightCyan + ansi.bold, "▸")
          : j === 0 && moreAbove
            ? span(ansi.fgGray, "↑")
            : j === listRows - 1 && moreBelow
              ? span(ansi.fgGray, "↓")
              : " "
      const activeTag = opt.active === true ? span(ansi.fgGray, " ◀ active") : ""
      const labelRoom = innerWidth - 2 - (opt.active === true ? 9 : 0)
      const label =
        idx === state.selected
          ? span(ansi.bold, truncate(opt.label, labelRoom))
          : truncate(opt.label, labelRoom)
      emit(row(`${marker} ${label}${activeTag}`))
    }
  }
  emit(fill(`├${horiz}┤`))
  const counter = n === 0 ? "0/0" : `${state.selected + 1}/${n}`
  emit(
    row(
      `${span(ansi.fgGray, "↑↓ move · type filter · ↵ select · esc cancel")}${" ".repeat(
        Math.max(0, innerWidth - 44 - visibleLength(counter)),
      )}${span(ansi.fgGray, counter)}`,
    ),
  )
  emit(fill(`╰${horiz}╯`))
  return out
}
