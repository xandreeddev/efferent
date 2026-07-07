import type { Option } from "effect"

/**
 * The model-role defaults smith ships with — the "agent with kimi 2.6 high,
 * kimi 2.7 code, and fast deepseek v4". All three are OVERRIDABLE the same way
 * the efferent CLI is configured: user `.efferent/config.json` (global/local)
 * wins over these, and CLI flags (`--model`/`--code-model`/`--fast-model`)
 * win over everything. See `settings/smithSettings.ts` for the precedence.
 */
export const SMITH_MODEL_DEFAULTS = {
  /** The loop's brain: the implementor conversation's root. */
  general: "opencode:kimi-k2.6",
  /** The fleet's code tier: `run_agent({ role: "code" })` delegates run here. */
  code: "opencode:kimi-k2.7-code",
  /** One-shot helpers: compaction digests, approval judge, titles. */
  fast: "opencode:deepseek-v4-flash",
} as const

/**
 * Non-model setting defaults. Rationale per knob:
 * - `openCodeThinkingMode: "high"` — kimi-k2.6 runs with extended thinking
 *   (the "kimi 2.6 HIGH" ask); `:set openCodeThinkingMode off` to disable.
 * - `autoLoop: false` — the foundry gate pipeline IS the verification; the
 *   runtime's Opus swarm gate would double-judge every attempt.
 * - `agentMode: "direct"` — the implementor root codes hands-on (no
 *   coordinator); code-heavy pieces still delegate by ROLE to the code tier.
 * - `maxSteps: 40` — one forge attempt is one substantial coder turn (the
 *   stock 20 is sized for interactive chat).
 * - small child/depth caps — the implementor may fan out a few role-scoped
 *   helpers, never a deep swarm.
 */
export const SMITH_SETTING_DEFAULTS = {
  openCodeThinkingMode: "high",
  autoLoop: false,
  agentMode: "direct",
  maxSteps: 40,
  subAgentMaxChildren: 4,
  subAgentMaxDepth: 1,
} as const

/** Forge-loop defaults (the `Spec.limits` seed; foundry validates the bounds). */
export const SMITH_LIMIT_DEFAULTS = {
  maxAttempts: 3,
  budgetMillis: 15 * 60_000,
} as const

/** Model-role overrides from the CLI flags; `None` = fall through to config. */
export interface SmithModelFlags {
  readonly general: Option.Option<string>
  readonly code: Option.Option<string>
  readonly fast: Option.Option<string>
}

/**
 * One forge session's resolved invocation — the argv product, defaults filled
 * at the edge. Bounds (`maxAttempts` 1..10, positive budget) are enforced by
 * foundry's `ForgeLimits` schema when the `Spec` is built.
 */
export interface SmithRunConfig {
  /** The task text — becomes `Spec.goal` (and the implementor's brief). */
  readonly task: string
  /** Absolute workspace dir smith forges IN PLACE (no temp copy). */
  readonly cwd: string
  /** Extra acceptance criteria (`--accept`, repeatable) — `Spec.acceptance`. */
  readonly acceptance: ReadonlyArray<string>
  readonly maxAttempts: number
  readonly budgetMillis: number
  readonly models: SmithModelFlags
  /** Let the implementor run Bash (headless allow-all approval) — off by default. */
  readonly allowBash: boolean
  /** `-p`/`--headless`: print mode, no TUI. */
  readonly headless: boolean
  /** `--test-cmd "<cmd>"` — overrides the auto-detected `bun test` gate. */
  readonly testCommand: Option.Option<string>
  /** `--no-test` — suppress the test gate even when package.json exists. */
  readonly noTest: boolean
  /** `--config <f>` — explicit foundry GateSuiteConfig module. */
  readonly configPath: Option.Option<string>
}
