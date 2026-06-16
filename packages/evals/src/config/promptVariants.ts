/**
 * Named system-prompt transforms. A `RunConfig.promptVariant` keys into this
 * registry; the transform is applied as a PURE function of the default coder
 * system prompt (`coderSystemPrompt(...)`), so A/B-testing a prompt change is
 * one entry here + a `promptVariant` in a config — no fork of the suite, and
 * the same telemetry/metrics path measures it.
 *
 * "default" is identity. Add variants (e.g. a terser tone, an extra rule) to
 * compare prompt edits against the baseline.
 */
export type PromptTransform = (base: string) => string

const identity: PromptTransform = (s) => s

export const PROMPT_VARIANTS: Record<string, PromptTransform> = {
  default: identity,
}

/** Resolve a variant key to its transform; unknown / unset ⇒ identity. */
export const promptTransform = (key?: string): PromptTransform =>
  key === undefined ? identity : (PROMPT_VARIANTS[key] ?? identity)
