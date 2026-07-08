import { Option } from "effect"
import type { EngineSettings, ModelRole } from "@xandreed/engine"
import { SMITH_MODEL_DEFAULTS } from "../../domain/SmithConfig.js"
import type { SelectOption } from "./selectBox.js"

/**
 * The `:model` picker's rows — a CURATED static catalogue (user decision: no
 * network fetch, no registry port in v1) seeded from the smith defaults plus
 * known-good ids per wired provider, with two synthetic rows:
 * - code/fast get a leading `default` row (value None → the key is CLEARED;
 *   under the smith overlay that falls back to the SMITH default, not to
 *   general — the label says so honestly);
 * - a filter containing `:` grows a trailing `use "<typed>"` row, the
 *   free-text escape for any model the list doesn't know.
 */

const CURATED: ReadonlyArray<string> = [
  SMITH_MODEL_DEFAULTS.general,
  SMITH_MODEL_DEFAULTS.code,
  SMITH_MODEL_DEFAULTS.fast,
  "opencode:qwen3-coder",
  "opencode:glm-4.7",
  "opencode:grok-code",
  "anthropic:claude-fable-5",
  "anthropic:claude-opus-4-8",
  "anthropic:claude-sonnet-5",
  "anthropic:claude-haiku-4-5",
  "openai:gpt-5.2",
  "openai:gpt-5.2-codex",
  "google:gemini-3.5-pro",
  "google:gemini-3.5-flash",
]

/** Curated context windows for the ctx gauge — best-effort constants per
 *  model family (the same no-network stance as the picker). Unknown → None
 *  and the gauge shows the absolute count only. */
const CONTEXT_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/kimi-k2/i, 256_000],
  [/deepseek/i, 128_000],
  [/qwen3/i, 256_000],
  [/glm-/i, 128_000],
  [/grok-code/i, 256_000],
  [/claude/i, 200_000],
  [/gpt-5/i, 400_000],
  [/gemini-3/i, 1_000_000],
]

export const contextWindowOf = (model: string): Option.Option<number> =>
  Option.fromNullable(CONTEXT_WINDOWS.find(([pattern]) => pattern.test(model))?.[1])

const ROLE_TITLE: Record<ModelRole, string> = {
  general: "Select the GENERAL model (refine + the session brain)",
  code: "Select the CODE model (the forge implementor)",
  fast: "Select the FAST model (one-shot helpers)",
}

const currentFor = (role: ModelRole, settings: EngineSettings): Option.Option<string> =>
  role === "general" ? settings.model : role === "code" ? settings.codeModel : settings.fastModel

export const modelPickerTitle = (role: ModelRole): string => ROLE_TITLE[role]

export const modelPickerOptions = (
  role: ModelRole,
  settings: EngineSettings,
): ReadonlyArray<SelectOption<Option.Option<string>>> => {
  const current = Option.getOrElse(currentFor(role, settings), () => "")
  const defaultRow: ReadonlyArray<SelectOption<Option.Option<string>>> =
    role === "general"
      ? []
      : [
          {
            value: Option.none(),
            label: `default (smith default: ${SMITH_MODEL_DEFAULTS[role]})`,
            desc: "clear the role",
          },
        ]
  const deduped = [...new Set(CURATED)]
  return [
    ...defaultRow,
    ...deduped.map((selection) => ({
      value: Option.some(selection),
      label: selection,
      active: selection === current,
    })),
  ]
}

/** The free-text escape: a `provider:modelId`-shaped filter becomes its own
 *  selectable row (appended so arrow-up reaches it in one keystroke). */
export const customRow = (
  filter: string,
): ReadonlyArray<SelectOption<Option.Option<string>>> => {
  const typed = filter.trim()
  return typed.includes(":") && typed.indexOf(":") > 0 && !typed.endsWith(":")
    ? [{ value: Option.some(typed), label: `use "${typed}"`, desc: "not in the list" }]
    : []
}
