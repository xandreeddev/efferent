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

/** Curated $/Mtok (input, output) per model family — the same no-network,
 *  best-effort-constants stance as the context windows. Unknown → None and
 *  the cost readout simply stays absent (never a made-up number). */
const PRICING: ReadonlyArray<readonly [RegExp, { readonly in: number; readonly out: number }]> = [
  [/kimi-k2/i, { in: 0.6, out: 2.5 }],
  [/deepseek/i, { in: 0.27, out: 1.1 }],
  [/qwen3/i, { in: 0.4, out: 1.2 }],
  [/glm-/i, { in: 0.5, out: 1.8 }],
  [/grok-code/i, { in: 1.0, out: 4.0 }],
  [/claude-(fable|opus)/i, { in: 15, out: 75 }],
  [/claude-sonnet/i, { in: 3, out: 15 }],
  [/claude-haiku/i, { in: 0.8, out: 4 }],
  [/gpt-5/i, { in: 1.25, out: 10 }],
  [/gemini-3\.5-pro/i, { in: 1.25, out: 10 }],
  [/gemini-3\.5-flash/i, { in: 0.15, out: 0.6 }],
]

/** Prefix-cache reads bill far below fresh input across vendors — 10% is
 *  the conservative curve (Anthropic 0.1×; DeepSeek similar). */
const CACHED_READ_FACTOR = 0.1

/** One turn's dollar cost for a model, when its family is priced. */
export const costOf = (
  model: string,
  usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
  },
): Option.Option<number> =>
  Option.map(
    Option.fromNullable(PRICING.find(([pattern]) => pattern.test(model))?.[1]),
    (rate) => {
      const fresh = Math.max(0, usage.inputTokens - usage.cacheReadTokens)
      return (
        (rate.in / 1_000_000) * fresh +
        (rate.in / 1_000_000) * CACHED_READ_FACTOR * usage.cacheReadTokens +
        (rate.out / 1_000_000) * usage.outputTokens
      )
    },
  )

/** "$1.24" / "$0.041" / "<$0.001" — three digits under a dime, never 0. */
export const fmtCost = (dollars: number): string =>
  dollars < 0.001 ? "<$0.001" : dollars < 0.1 ? `$${dollars.toFixed(3)}` : `$${dollars.toFixed(2)}`

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
