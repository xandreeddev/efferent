import { Schema } from "effect"

export const EditorMode = Schema.Literal("insert", "vi")
export type EditorMode = typeof EditorMode.Type

export const Settings = Schema.Struct({
  allowBash: Schema.Boolean.annotations({
    description: "Whether the agent can execute bash commands without prompting in non-interactive modes.",
  }),
  maxSteps: Schema.Number.annotations({
    description: "The maximum number of steps allowed in the agent loop.",
  }),
  editorMode: EditorMode.annotations({
    description: "TUI input editor mode: 'insert' (default emacs-style) or 'vi' (modal vi-lite).",
  }),
})

export type Settings = typeof Settings.Type

export const DefaultSettings: Settings = {
  allowBash: false,
  maxSteps: 20,
  editorMode: "insert",
}
