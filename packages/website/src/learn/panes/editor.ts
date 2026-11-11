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
import { DEFAULT_CONFIG, DEFINE_START_MARK, SECTIONS, programOf } from "../lesson1.source.ts"
import { DEFAULT_TINY, TINY_INTRO, tinyProgramOf } from "../tiny-memory.source.ts"
import { formatRegion } from "../format.ts"
import type { Formatted } from "../format.ts"

export type FileName = "agent" | "tiny"
export type Section = "imports" | "session" | "define"

export interface CodeEditor {
  readonly file: () => FileName
  readonly showFile: (file: FileName) => void
  readonly agentConfig: () => string
  readonly tinySource: () => string
  readonly setAgentConfig: (text: string) => void
  readonly setTinySource: (text: string) => void
  /** Fold exactly these read-only sections of agent.ts; the rest are open. */
  readonly foldOnly: (folded: ReadonlyArray<Section>) => void
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

const chipLabel = (start: string): string =>
  start.startsWith("import") ? "imports"
    : start.startsWith("// Conversations") ? "session setup"
      : start.startsWith("const agent") || start.startsWith("// One message") ? "define the agent and run a turn"
        : "read-only"

const folding = codeFolding({
  preparePlaceholder: (state, range) => state.doc.sliceString(range.from, Math.min(range.to, range.from + 24)),
  placeholderDOM: (_view, onclick, prepared) => {
    const chip = document.createElement("span")
    chip.className = "cm-fold-chip"
    chip.textContent = `${chipLabel(String(prepared))}  ▸`
    chip.title = "Read-only. Click to show."
    chip.addEventListener("click", onclick)
    return chip
  },
})

const baseExtensions = (onRebuild: () => void, onEdit: () => void, onFormat: () => void): Extension[] => [
  lineNumbers(),
  history(),
  drawSelection(),
  highlightActiveLine(),
  bracketMatching(),
  indentOnInput(),
  javascript(),
  syntaxHighlighting(classHighlighter),
  folding,
  lockedLines,
  EditorState.tabSize.of(2),
  EditorView.lineWrapping,
  keymap.of([{ key: "Mod-Enter", run: () => { onRebuild(); return true } }, { key: "Shift-Alt-f", run: () => { onFormat(); return true } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
  EditorView.updateListener.of((update) => { if (update.docChanged) onEdit() }),
]

export const mountEditor = (host: HTMLElement, hooks: { onRebuild: () => void; onEdit: () => void; onFormat: () => void }): CodeEditor => {
  const agentDoc = programOf(DEFAULT_CONFIG)
  const configFrom = SECTIONS.configFrom
  const make = (doc: string, region: { from: number; to: number }) =>
    EditorState.create({ doc, extensions: [...baseExtensions(hooks.onRebuild, hooks.onEdit, hooks.onFormat), lockedExtension(region)] })

  const states: Record<FileName, EditorState> = {
    agent: make(agentDoc, { from: configFrom, to: configFrom + DEFAULT_CONFIG.length }),
    tiny: make(tinyProgramOf(DEFAULT_TINY), { from: TINY_INTRO.length, to: TINY_INTRO.length + DEFAULT_TINY.length }),
  }
  let current: FileName = "agent"
  const view = new EditorView({ state: states.agent, parent: host })

  const save = () => { states[current] = view.state }
  const stateOf = (file: FileName) => (file === current ? view.state : states[file])
  const textOf = (file: FileName) => editableText(stateOf(file))
  const replace = (file: FileName, text: string) => {
    const state = stateOf(file)
    const { from, to } = state.field(regionField)
    // The program's own edit (a control, a reset): it bypasses the learner's lock.
    const spec = { changes: { from, to, insert: text }, filter: false }
    if (file === current) view.dispatch(spec)
    else states[file] = state.update(spec).state
  }

  const sectionRanges = (state: EditorState): Record<Section, { from: number; to: number }> => {
    const { to } = state.field(regionField)
    const doc = state.doc.toString()
    const defineFrom = doc.indexOf(DEFINE_START_MARK, to)
    return {
      imports: SECTIONS.imports,
      session: SECTIONS.session,
      define: { from: defineFrom < 0 ? doc.length : defineFrom, to: doc.length },
    }
  }

  return {
    file: () => current,
    showFile: (file) => {
      if (file === current) return
      save()
      current = file
      view.setState(states[file])
    },
    agentConfig: () => textOf("agent"),
    tinySource: () => textOf("tiny"),
    setAgentConfig: (text) => replace("agent", text),
    setTinySource: (text) => replace("tiny", text),
    foldOnly: (folded) => {
      if (current !== "agent") return
      const effects: StateEffect<unknown>[] = []
      const open = foldedRanges(view.state)
      open.between(0, view.state.doc.length, (from, to) => { effects.push(unfoldEffect.of({ from, to })) })
      const ranges = sectionRanges(view.state)
      for (const section of folded) {
        const range = ranges[section]
        if (range.to > range.from) effects.push(foldEffect.of(range))
      }
      view.dispatch({ effects })
    },
    format: async () => {
      const file = current
      const before = textOf(file)
      const result = await formatRegion(before, file === "agent" ? "const config = " : "const tinyMemory = ")
      // Typing while Prettier loaded wins: formatting stale text would undo it.
      if (result.ok && result.text !== before && textOf(file) === before) replace(file, result.text)
      return result
    },
    focus: () => view.focus(),
  }
}
