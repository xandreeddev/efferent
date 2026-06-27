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
        "Total token budget (input+output) shared by ALL sub-agents spawned within one top-level turn. 0 disables the cap (unlimited — for long unattended fleet runs). Unset → 4000000.",
    }),
  ),
  subAgentMaxSteps: Schema.optional(
    Schema.Number.annotations({
      description:
        "Step (turn) cap for each spawned sub-agent's loop. Unset → 200. A capped run returns its partial work marked '[stopped early …]'.",
    }),
  ),
  subAgentMaxDepth: Schema.optional(
    Schema.Number.annotations({
      description:
        "Sub-agent nesting depth: how many levels deep the fleet can spawn (root → coordinator → … ). Unset → 3. Raise it for deeper hierarchical fleets on big jobs; a spawn past the cap returns MaxDepthReached as a tool failure.",
    }),
  ),
  subAgentFetchBudget: Schema.optional(
    Schema.Number.annotations({
      description:
        "Per-sub-agent web-lookup budget: max combined web_fetch + search_web calls ONE spawned agent makes in its whole run before the tools refuse with a 'report now' signal — the deterministic brake on a fleet worker that over-researches. Unset → 15. 0 disables (no cap). The root coder is always exempt.",
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
        "Export OpenTelemetry traces + metrics for every session. This is the SOLE switch (`:set telemetry on`); unset/false → no export (zero overhead). When on, each LLM call's prompt + completion text is captured as `gen_ai.prompt`/`gen_ai.completion` span attributes (clipped) so traces show the I/O. The OTLP endpoint defaults to http://localhost:4318 (a local grafana/otel-lgtm), override with OTEL_EXPORTER_OTLP_ENDPOINT — that controls WHERE, not WHETHER.",
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
        "The FAST role: model for one-shot helper calls (tool-output summaries, auto-approval judgments, session titles), as '<provider>:<modelId>'. Unset → the main model.",
    }),
  ),
  codeModel: Schema.optional(
    Schema.String.annotations({
      description:
        "The CODE role: model the spawned coding sub-agents (the fleet) run on, as '<provider>:<modelId>'. Sub-agents never choose their own model — this is the single knob for the whole fleet. Unset → the main model.",
    }),
  ),
  toolResultMaxTokens: Schema.optional(
    Schema.Number.annotations({
      description:
        "Compaction: per-string token budget for a tool result entering the context (≈chars/4). Oversized results are clipped head+tail with a reversible marker (+ a fast-tier digest of the dropped middle). Unset → 4000; 0 disables.",
    }),
  ),
  autoHandoffPct: Schema.optional(
    Schema.Number.annotations({
      description:
        "Auto-fold threshold: when a turn's context reaches this percent of the window, the TUI runs :handoff automatically at the next turn boundary. Unset → 85; 0 disables.",
    }),
  ),
  autoLoop: Schema.optional(
    Schema.Boolean.annotations({
      description:
        "The self-improving task loop: when the fleet handles a substantial task, the coordinator submits the deliverable to the independent Opus gate, learns from a 'needs work' verdict (note_constraint), and retries until it passes (capped). Unset → on; false → the coordinator just reports the architect's verdict (today's single-cycle behavior).",
    }),
  ),
  autoDistill: Schema.optional(
    Schema.Boolean.annotations({
      description:
        "Learn-for-next-runs: at each finished turn the runtime mines the conversation for reusable skills/constraints (cheap fast tier), verifies each with the Opus gate, and persists the survivors so future runs inherit them. Unset → on; false → no automatic distillation (run `efferent distill` manually instead).",
    }),
  ),
  maxLoopAttempts: Schema.optional(
    Schema.Number.annotations({
      description:
        "Self-improving loop: max Opus-gate rounds before the coordinator delivers what it has. Unset → 3 (the article's typical convergence). 1 disables the retry (gate once, deliver). Token budget + spawn depth are the hard ceilings regardless.",
    }),
  ),
  theme: Schema.optional(
    Schema.String.annotations({
      description:
        "Active TUI colour theme name (e.g. 'one-dark', 'tokyo-night'). Switch at runtime with :theme; unknown names fall back to the default.",
    }),
  ),
  onboarded: Schema.optional(
    Schema.Boolean.annotations({
      description: "Whether first-run onboarding has completed.",
    }),
  ),
  dbUrl: Schema.optional(
    Schema.String.annotations({
      description:
        "Legacy single conversation-store location (superseded by `databases`/`defaultDatabase`, still honored). A 'postgres://…' connection string selects Postgres; anything else (a filesystem path, optionally 'sqlite:'-prefixed) selects SQLite at that path. Unset → SQLite at ~/.efferent/efferent.db. The EFFERENT_DB_URL env var overrides this.",
    }),
  ),
  databases: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Struct({
        kind: Schema.Literal("sqlite", "postgres"),
        url: Schema.String,
      }),
    }).annotations({
      description:
        "Named database connections beyond the implicit zero-config 'local' SQLite. Keyed by name; `url` is a file path (sqlite) or a postgres:// connection string. Add/switch them live via :db or onboarding.",
    }),
  ),
  defaultDatabase: Schema.optional(
    Schema.String.annotations({
      description:
        "Name of the active database at boot — a key in `databases`, or 'local' for the zero-config SQLite. Switchable live (no restart) via :db / the sessions tabs.",
    }),
  ),
  grafanaUrl: Schema.optional(
    Schema.String.annotations({
      description:
        "Base URL of the Grafana instance for the :traces / :dashboard deep links (the local grafana/otel-lgtm UI). Unset → http://localhost:3000.",
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
