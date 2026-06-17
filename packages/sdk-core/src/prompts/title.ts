import type { Prompt } from "../entities/Prompt.js"

const TITLE_PROMPT_VERSION = "1.0.0"

const TITLE_TEXT = `Name this coding session. Reply with ONLY the title: at most 6 words, concrete and specific to the task (prefer file/feature names over generic verbs), no quotes, no trailing period, no preamble.`

/**
 * Prompt for naming a session after its first exchange. The title shows in the
 * sessions pane / startup picker, replacing the raw first-prompt preview — it
 * must be scannable in a one-line list, so: short, concrete, no decoration.
 */
export const TITLE_PROMPT = TITLE_TEXT

/** The title prompt as a versioned {@link Prompt}. */
export const titlePrompt = (variant?: string): Prompt => ({
  name: "title",
  version: TITLE_PROMPT_VERSION,
  variant,
  text: TITLE_TEXT,
})
