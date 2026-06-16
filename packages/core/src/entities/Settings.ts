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
  subAgentTokenBudget: Schema.optional(
    Schema.Number.annotations({
      description:
        "Total token budget (input+output) shared by ALL sub-agents spawned within one top-level turn. 0 disables the cap. Unset → 1000000.",
    }),
  ),
  subAgentMaxSteps: Schema.optional(
    Schema.Number.annotations({
      description:
        "Step (turn) cap for each spawned sub-agent's loop. Unset → 80. A capped run returns its partial work marked '[stopped early …]'.",
    }),
  ),
  approvedBashRules: Schema.optional(
    Schema.Array(Schema.String).annotations({
      description:
        "Bash approval rules allowed for this project ('cmd:bun test', 'exact:…') — written by the TUI approval modal's 'always allow in this project' answer.",
    }),
  ),
  approvedFolders: Schema.optional(
    Schema.Array(Schema.String).annotations({
      description:
        "Folders (absolute paths) the auto-approval judge treats as permitted in this project, beyond the workspace root — written by the approval modal's 'always allow in this project' answer when a command reached outside.",
    }),
  ),
  autoApprove: Schema.optional(
    Schema.Boolean.annotations({
      description:
        "Auto-approval mode: a FAST-tier judge classifies unmatched bash commands, silently allowing ordinary work inside permitted folders (workspace root + granted folders); everything else still prompts. Unset → on; false → every unmatched command prompts.",
    }),
  ),
  autoCollapse: Schema.optional(
    Schema.Boolean.annotations({
      description:
        "TUI conversation pane: fold every previous turn to one line when a new message is sent, keeping only the live turn expanded. Unset → off (turns stay as you left them).",
    }),
  ),
  telemetry: Schema.optional(
    Schema.Boolean.annotations({
      description:
        "Export OpenTelemetry traces + metrics for every session to the OTLP endpoint (OTEL_EXPORTER_OTLP_ENDPOINT, default http://localhost:4318 — a local grafana/otel-lgtm). Unset/false → no export (zero overhead). Also enabled by EFFERENT_OTLP.",
    }),
  ),
  editorMode: EditorMode.annotations({
    description: "TUI input editor mode: 'insert' (default emacs-style) or 'vi' (modal vi-lite).",
  }),
  model: Schema.String.annotations({
    description: "Active model as '<provider>:<modelId>' (e.g. 'google:gemini-3.5-flash', 'openai:gpt-4o'). Switch at runtime with /model.",
  }),
  searchModel: Schema.optional(
    Schema.String.annotations({
      description:
        "Dedicated web search model as '<provider>:<modelId>' (google/openai only); used by search_web independently of the chat model.",
    }),
  ),
  fastModel: Schema.optional(
    Schema.String.annotations({
      description:
        "The FAST role: model for helper calls (tool-output summaries, auto-approval judgments, session titles), as '<provider>:<modelId>'. Sub-agents are real work and run on main. Unset → the main model.",
    }),
  ),
  toolResultMaxTokens: Schema.optional(
    Schema.Number.annotations({
      description:
        "Headroom: per-string token budget for a tool result entering the context (≈chars/4). Oversized results are clipped head+tail with a reversible marker (+ a fast-tier digest of the dropped middle). Unset → 4000; 0 disables.",
    }),
  ),
  autoHandoffPct: Schema.optional(
    Schema.Number.annotations({
      description:
        "Auto-fold threshold: when a turn's context reaches this percent of the window, the TUI runs :handoff automatically at the next turn boundary. Unset → 85; 0 disables.",
    }),
  ),
  theme: Schema.optional(
    Schema.String.annotations({
      description:
        "Active TUI colour theme name (e.g. 'one-dark', 'tokyo-night'). Switch at runtime with :theme; unknown names fall back to the default.",
    }),
  ),
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
