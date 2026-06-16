/**
 * A `RunConfig` pins everything that changes the agent's behaviour for an eval
 * run — the main model, the fast (helper) model, an optional system-prompt
 * variant, the step cap, the headroom budget — so a model or prompt change is
 * one config you can A/B against a baseline. Injected as a fixed `SettingsStore`
 * layer (`settingsLayer.ts`) that the router and every fast-tier helper read
 * per request, so one config governs the whole run with zero core changes.
 */
export interface RunConfig {
  /** Label for the results filename + the comparison table column. */
  readonly name: string
  /** Main model as "<provider>:<modelId>" → `settings.model`. */
  readonly main: string
  /** Fast/helper model → `settings.fastModel`. Unset ⇒ follows main. */
  readonly fast?: string
  /**
   * Pin the `llmJudge` model so a baseline and a candidate are graded by the
   * SAME judge. Unset ⇒ the judge runs on whatever `LanguageModel` is in
   * context (i.e. `main`), which makes judge scores incomparable across configs.
   */
  readonly judge?: string
  /** Key into the `promptVariants` registry. Unset / "default" ⇒ identity. */
  readonly promptVariant?: string
  /** Agent-loop step cap → `settings.maxSteps`. */
  readonly maxSteps?: number
  /** Per-tool-result headroom budget (tokens) → `settings.toolResultMaxTokens`. */
  readonly toolResultMaxTokens?: number
}

/**
 * A short, stable hash of a config's *substantive* knobs (not its `name`), used
 * in result filenames so identical configs land in comparable files. FNV-1a
 * over a canonical JSON — no crypto dependency, deterministic across runs.
 */
export const configHash = (c: RunConfig): string => {
  const canonical = JSON.stringify({
    main: c.main,
    fast: c.fast ?? null,
    judge: c.judge ?? null,
    promptVariant: c.promptVariant ?? null,
    maxSteps: c.maxSteps ?? null,
    toolResultMaxTokens: c.toolResultMaxTokens ?? null,
  })
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}
