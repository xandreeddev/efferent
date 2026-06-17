/**
 * A **generic, domain-free form field** — the design-system control the CLI's
 * settings / login / any key-value editor is *composed from* (not the other way
 * round). One control, four value kinds: `text`, `number`, `boolean`, `select`.
 *
 * Pure L1: state + reducers, no Solid/OpenTUI and no app types. The view is
 * `view/ui/Field.tsx`; consumers map their keys to these semantic reducers
 * (`toggleField` / `cycleField` / `appendChar` / `backspaceField`).
 */

export type FieldKind = "text" | "number" | "boolean" | "select"

export type FieldValue =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "select"; readonly value: string; readonly options: ReadonlyArray<string> }

export interface FieldState {
  readonly label: string
  readonly value: FieldValue
  /** In-progress numeric entry (e.g. `"1."`, `"-"`), so partial input survives
   *  the reparse to `number`. Unused for the other kinds. */
  readonly numberDraft?: string
}

export const field = (label: string, value: FieldValue): FieldState => ({ label, value })

/** Flip a boolean field; no-op for other kinds. */
export const toggleField = (s: FieldState): FieldState =>
  s.value.kind === "boolean" ? { ...s, value: { ...s.value, value: !s.value.value } } : s

/** Step a select field to the previous (`-1`) / next (`+1`) option, wrapping. */
export const cycleField = (s: FieldState, dir: -1 | 1): FieldState => {
  if (s.value.kind !== "select") return s
  const { options, value } = s.value
  if (options.length === 0) return s
  const i = Math.max(0, options.indexOf(value))
  const next = (i + dir + options.length) % options.length
  return { ...s, value: { ...s.value, value: options[next]! } }
}

/** Append a typed character to a text/number field (number filters to `-0-9.`). */
export const appendChar = (s: FieldState, ch: string): FieldState => {
  if (s.value.kind === "text") return { ...s, value: { ...s.value, value: s.value.value + ch } }
  if (s.value.kind === "number") {
    if (!/[-0-9.]/.test(ch)) return s
    const draft = (s.numberDraft ?? String(s.value.value)) + ch
    const n = Number(draft)
    return { ...s, numberDraft: draft, value: { ...s.value, value: Number.isFinite(n) ? n : s.value.value } }
  }
  return s
}

/** Delete the last character of a text/number field. */
export const backspaceField = (s: FieldState): FieldState => {
  if (s.value.kind === "text") return { ...s, value: { ...s.value, value: s.value.value.slice(0, -1) } }
  if (s.value.kind === "number") {
    const draft = (s.numberDraft ?? String(s.value.value)).slice(0, -1)
    const n = Number(draft)
    return {
      ...s,
      numberDraft: draft,
      value: { ...s.value, value: draft.length > 0 && Number.isFinite(n) ? n : 0 },
    }
  }
  return s
}

/** The string shown in the field's value slot (the live draft while editing a number). */
export const fieldDisplay = (s: FieldState): string => {
  const v = s.value
  switch (v.kind) {
    case "text":
      return v.value
    case "number":
      return s.numberDraft ?? String(v.value)
    case "boolean":
      return v.value ? "on" : "off"
    case "select":
      return v.value
  }
}
