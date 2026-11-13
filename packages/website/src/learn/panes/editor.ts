// The code pane: one CodeMirror editor showing a whole file, of which the
// learner may change only the marked region (see editor-locks.ts).
import { EditorState, RangeSetBuilder } from "@codemirror/state"
import type { StateEffect } from "@codemirror/state"
import type { Extension } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view"
import type { DecorationSet, ViewUpdate } from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { javascript } from "@codemirror/lang-javascript"
import { bracketMatching, codeFolding, foldEffect, foldedRanges, indentOnInput, syntaxHighlighting, unfoldEffect } from "@codemirror/language"
import { classHighlighter } from "@lezer/highlight"
import { editableText, lockedExtension, regionField } from "../editor-locks.ts"
import { formatRegion } from "../format.ts"
import type { Formatted } from "../format.ts"
import type { LessonFile, LessonSection, Sources } from "../lesson.ts"

export interface CodeEditor {
  /** The id of the file shown. */
  readonly file: () => string
  /** Show a file of the lesson; an id it has not is ignored. */
  readonly showFile: (file: string) => void
  /** The editable text of one file. */
  readonly source: (file: string) => string
  /** The editable text of every file, by id. */
  readonly sources: () => Sources
  readonly setSource: (file: string, text: string) => void
  /** Fold exactly these read-only sections of the file shown, by id; the rest are open. */
  readonly foldOnly: (folded: ReadonlyArray<string>) => void
  /** Format the editable code of the open file (the part you can change), keeping the undo history. */
  readonly format: () => Promise<Formatted>
  readonly focus: () => void
}

const lockedLine = Decoration.line({ class: "cm-locked" })

/** Dim every line that lies wholly outside the editable region. */
const lockedLines = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = this.build(view) }
  update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view) }
  build(view: EditorView): DecorationSet {
    const { from, to } = view.state.field(regionField)
    const builder = new RangeSetBuilder<Decoration>()
    for (const range of view.visibleRanges) {
      for (let pos = range.from; pos <= range.to;) {
        const line = view.state.doc.lineAt(pos)
        if (line.to < from || line.from > to) builder.add(line.from, line.from, lockedLine)
        pos = line.to + 1
      }
    }
    return builder.finish()
  }
}, { decorations: (plugin) => plugin.decorations })

/** Where each section of a file is, in the state given. */
const rangesOf = (state: EditorState, sections: ReadonlyArray<LessonSection>) => {
  const doc = state.doc.toString()
  const editable = state.field(regionField)
  return sections.map((section) => ({ section, range: section.range(doc, editable) }))
}

/** Folding for one file: a folded section shows as a chip with its label. */
const folding = (sections: ReadonlyArray<LessonSection>) => codeFolding({
  preparePlaceholder: (state, range) =>
    rangesOf(state, sections).find((entry) => entry.range.from === range.from)?.section.label ?? "read-only",
  placeholderDOM: (_view, onclick, prepared) => {
    const chip = document.createElement("span")
    chip.className = "cm-fold-chip"
    chip.textContent = `${String(prepared)}  ▸`
    chip.title = "Read-only. Click to show."
    chip.addEventListener("click", onclick)
    return chip
  },
})

const baseExtensions = (sections: ReadonlyArray<LessonSection>, onRebuild: () => void, onEdit: () => void, onFormat: () => void): Extension[] => [
  lineNumbers(),
  history(),
  drawSelection(),
  highlightActiveLine(),
  bracketMatching(),
  indentOnInput(),
  javascript(),
  syntaxHighlighting(classHighlighter),
  folding(sections),
  lockedLines,
  EditorState.tabSize.of(2),
  EditorView.lineWrapping,
  keymap.of([{ key: "Mod-Enter", run: () => { onRebuild(); return true } }, { key: "Shift-Alt-f", run: () => { onFormat(); return true } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
  EditorView.updateListener.of((update) => { if (update.docChanged) onEdit() }),
]

export const mountEditor = (
  host: HTMLElement,
  files: ReadonlyArray<LessonFile>,
  /** The file shown first. */
  mainFile: string,
  hooks: { onRebuild: () => void; onEdit: () => void; onFormat: () => void },
): CodeEditor => {
  const first = files.find((file) => file.id === mainFile)
  if (first === undefined) throw new Error(`the lesson has no file ${mainFile}`)
  const make = (file: LessonFile) => EditorState.create({
    doc: file.documentOf(file.defaultText),
    extensions: [
      ...baseExtensions(file.sections, hooks.onRebuild, hooks.onEdit, hooks.onFormat),
      lockedExtension({ from: file.editableFrom, to: file.editableFrom + file.defaultText.length }),
      ...(file.readOnly ? [EditorState.readOnly.of(true)] : []),
    ],
  })

  const byId = new Map(files.map((file) => [file.id, file]))
  const states = new Map(files.map((file) => [file.id, make(file)]))
  let current = first.id
  const view = new EditorView({ state: make(first), parent: host })
  states.set(current, view.state)

  const save = () => { states.set(current, view.state) }
  const stateOf = (file: string): EditorState => {
    const state = file === current ? view.state : states.get(file)
    if (state === undefined) throw new Error(`the lesson has no file ${file}`)
    return state
  }
  const textOf = (file: string) => editableText(stateOf(file))
  const replace = (file: string, text: string) => {
    const state = stateOf(file)
    const { from, to } = state.field(regionField)
    // The program's own edit (a control, a reset): it bypasses the learner's lock.
    const spec = { changes: { from, to, insert: text }, filter: false }
    if (file === current) view.dispatch(spec)
    else states.set(file, state.update(spec).state)
  }

  return {
    file: () => current,
    showFile: (file) => {
      const next = states.get(file)
      if (file === current || next === undefined) return
      save()
      current = file
      view.setState(next)
    },
    source: textOf,
    sources: () => Object.fromEntries(files.map((file) => [file.id, textOf(file.id)])),
    setSource: replace,
    foldOnly: (folded) => {
      const sections = byId.get(current)?.sections ?? []
      if (sections.length === 0) return
      const effects: StateEffect<unknown>[] = []
      const open = foldedRanges(view.state)
      open.between(0, view.state.doc.length, (from, to) => { effects.push(unfoldEffect.of({ from, to })) })
      for (const { section, range } of rangesOf(view.state, sections)) {
        if (folded.includes(section.id) && range.to > range.from) effects.push(foldEffect.of(range))
      }
      view.dispatch({ effects })
    },
    format: async () => {
      const file = current
      if (byId.get(file)?.readOnly === true) return { ok: true, text: textOf(file) }
      const before = textOf(file)
      const result = await formatRegion(before, byId.get(file)?.formatPrefix ?? "")
      // Typing while Prettier loaded wins: formatting stale text would undo it.
      if (result.ok && result.text !== before && textOf(file) === before) replace(file, result.text)
      return result
    },
    focus: () => view.focus(),
  }
}
