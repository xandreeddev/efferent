/**
 * A versioned system prompt. Bundling identity (name, version, optional variant)
 * with the text lets telemetry label every LLM call with the exact prompt that
 * produced it, while keeping the raw string available for the agent loop.
 */
export interface Prompt {
  /** Stable prompt family, e.g. "coder" or "title". */
  readonly name: string
  /**
   * Semantic version of this prompt's behavior. Bump when instructions change
   * in a way that could affect model outputs — this is the A/B baseline/candidate
   * discriminator in traces and evals.
   */
  readonly version: string
  /** Optional variant within the family (e.g. A/B test key). "default" when absent. */
  readonly variant?: string | undefined
  /** The rendered system-prompt text passed to the model. */
  readonly text: string
}

/**
 * Build a display label for telemetry: `name:variant@version`. The variant is
 * omitted when it's "default" or unset, so the common case stays short.
 */
export const promptLabel = (prompt: Prompt): string => {
  const variant = prompt.variant === undefined || prompt.variant === "default" ? "" : `:${prompt.variant}`
  return `${prompt.name}${variant}@${prompt.version}`
}
