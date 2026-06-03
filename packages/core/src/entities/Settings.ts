import { Schema } from "effect"
import { DefaultModel } from "./Model.js"

export const EditorMode = Schema.Literal("insert", "vi")
export type EditorMode = typeof EditorMode.Type

export const AnthropicThinkingEffort = Schema.Literal("off", "low", "medium", "high")
export type AnthropicThinkingEffort = typeof AnthropicThinkingEffort.Type

export const OpenAiReasoningEffort = Schema.Literal("none", "minimal", "low", "medium", "high")
export type OpenAiReasoningEffort = typeof OpenAiReasoningEffort.Type

export const GeminiThinkingLevel = Schema.Literal("off", "minimal", "low", "medium", "high")
export type GeminiThinkingLevel = typeof GeminiThinkingLevel.Type

export const OpenCodeThinkingMode = Schema.Literal("off", "high")
export type OpenCodeThinkingMode = typeof OpenCodeThinkingMode.Type

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
  model: Schema.String.annotations({
    description: "Active model as '<provider>:<modelId>' (e.g. 'google:gemini-3.5-flash', 'openai:gpt-4o'). Switch at runtime with /model.",
  }),
  dbUrl: Schema.optional(
    Schema.String.annotations({
      description:
        "Conversation store location. A 'postgres://…' connection string selects Postgres; anything else (a filesystem path, optionally 'sqlite:'-prefixed) selects SQLite at that path. Unset → SQLite at ~/.efferent/efferent.db. The EFFERENT_DB_URL env var overrides this.",
    }),
  ),
  anthropicThinkingEffort: Schema.optional(
    AnthropicThinkingEffort.annotations({
      description:
        "Claude extended-thinking effort. Omit to use provider defaults; 'off' sends thinking disabled; low/medium/high map to token budgets.",
    }),
  ),
  openAiReasoningEffort: Schema.optional(
    OpenAiReasoningEffort.annotations({
      description:
        "OpenAI reasoning effort for reasoning models. Omit to use provider defaults.",
    }),
  ),
  geminiThinkingLevel: Schema.optional(
    GeminiThinkingLevel.annotations({
      description:
        "Gemini thinking level. Omit to use provider defaults; 'off' disables thought budget when supported.",
    }),
  ),
  openCodeThinkingMode: Schema.optional(
    OpenCodeThinkingMode.annotations({
      description:
        "OpenCode (Kimi) thinking mode. 'off' disables extended thinking; 'high' enables it.",
    }),
  ),
})

export type Settings = typeof Settings.Type

export const DefaultSettings: Settings = {
  allowBash: false,
  maxSteps: 20,
  editorMode: "insert",
  model: DefaultModel,
}

/**
 * Mask the password in a `postgres://user:pass@host/db` URL for display/logs.
 * Non-Postgres values (SQLite paths) are passed through unchanged. Pure
 * string helper — safe to use anywhere a `dbUrl` is shown to a human.
 */
export const maskDbUrl = (url: string): string => {
  if (!/^postgres(ql)?:\/\//i.test(url)) return url
  return url.replace(/^(postgres(?:ql)?:\/\/[^:/@]+:)[^@]*(@)/i, "$1***$2")
}
