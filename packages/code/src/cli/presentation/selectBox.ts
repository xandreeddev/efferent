/**
 * A reusable, pure select-box overlay — a navigable list with a type-to-filter
 * line and a windowed view that follows the highlight (pi's provider/model
 * selector UX). Generalises the slash-palette pattern (`slashPalette.ts`) into
 * something `:model` (and future pickers) can drive. Pure: state + reducers —
 * the OpenTUI `SelectList` component renders it.
 */

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
