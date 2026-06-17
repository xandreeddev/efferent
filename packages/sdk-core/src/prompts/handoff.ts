import type { Prompt } from "../entities/Prompt.js"

const HANDOFF_PROMPT_VERSION = "1.0.0"

const HANDOFF_TEXT = `You are summarizing a coding-agent conversation into a HANDOFF that will replace the detailed history. From the next turn onward this summary is the ONLY prior context the agent sees, so it must stand alone — be specific and complete enough to continue the work without the original messages.

Produce a concise, structured brief with these sections:

1. **Goal** — what the user is ultimately trying to accomplish.
2. **State & what's done** — concrete progress: files created/modified (with paths), commands/tools run and their outcomes, decisions made and key findings. Be specific; name real paths and symbols.
3. **Next steps** — what remains, in order.
4. **Constraints & preferences** — instructions, conventions, or preferences the user emphasized that must carry forward.

Rules: write only the summary, no preamble or sign-off. Prefer precise nouns (paths, function names, commands) over vague description. Do not invent facts not present in the conversation. If a section has nothing, write "none".`

/**
 * System prompt for generating a handoff summary. The summary REPLACES the
 * loaded history: from the next turn on, it's the only prior context the model
 * sees, so it must be self-contained and precise. (The original messages stay
 * in the store for browsing, but are never re-fed to the model.)
 */
export const HANDOFF_PROMPT = HANDOFF_TEXT

/** The handoff prompt as a versioned {@link Prompt}. */
export const handoffPrompt = (variant?: string): Prompt => ({
  name: "handoff",
  version: HANDOFF_PROMPT_VERSION,
  variant,
  text: HANDOFF_TEXT,
})
