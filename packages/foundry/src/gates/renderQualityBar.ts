import { Option } from "effect"
import type { GateSuiteConfig } from "../domain/Rules.js"
import type { IdiomRule } from "./idiomGate.js"

/**
 * The ARMED quality bar, rendered from the config itself (single source of
 * truth — never hand-written prose) for every stage of the loop: teach the
 * coder FORWARD on attempt 1, remind it on every retry, brief the judge on
 * what is already enforced. Pure and deterministic; byte-stable per config
 * (prompt-cache friendly).
 */
export interface QualityBar {
  /** Attempt-1 brief / refiner / post-fold re-injection (≤2,500 chars). */
  readonly full: string
  /** Every retry brief (≤800 chars). */
  readonly compact: string
  /** The judge prompt's standing-contract section (≤1,500 chars). */
  readonly judge: string
}

const FULL_CAP = 2_500
const COMPACT_CAP = 800
const JUDGE_CAP = 1_500

const clip = (text: string, cap: number): string =>
  text.length <= cap ? text : `${text.slice(0, cap)}\n[…quality bar clipped…]`

/** Config rules resolved against the plugged registry — unknown ids are
 *  SKIPPED here (the gate itself crashes on them; the renderer is an aid),
 *  duplicates keep their first occurrence. */
const armedRules = (
  config: GateSuiteConfig,
  registry: ReadonlyArray<IdiomRule>,
): ReadonlyArray<IdiomRule> =>
  config.rules
    .flatMap((entry) => registry.filter((rule) => rule.id === entry.rule).slice(0, 1))
    .filter((rule, index, all) => all.findIndex((r) => r.id === rule.id) === index)

const boundariesDigest = (config: GateSuiteConfig): ReadonlyArray<string> =>
  Option.match(config.boundaries, {
    onNone: () => [],
    onSome: (layers) => [
      "Dependency boundaries (enforced — an import outside these is rejected):",
      ...layers.layers.map(
        (layer) =>
          `- ${layer.name} may import: ${
            layer.canImport.length > 0 ? layer.canImport.join(", ") : "(nothing internal)"
          }`,
      ),
    ],
  })

/** `None` when the config arms nothing the renderer can speak about. */
export const renderQualityBar = (
  config: GateSuiteConfig,
  registry: ReadonlyArray<IdiomRule>,
): Option.Option<QualityBar> => {
  const rules = armedRules(config, registry)
  const boundaries = boundariesDigest(config)
  if (rules.length === 0 && boundaries.length === 0) return Option.none()

  const full = clip(
    [
      "## Quality bar (ARMED in this workspace — the deterministic gates WILL reject violations; write to these rules the first time)",
      ...rules.map((rule) => `- [${rule.id}] ${rule.description} — fix: ${rule.fixHint}`),
      ...(boundaries.length > 0 ? ["", ...boundaries] : []),
    ].join("\n"),
    FULL_CAP,
  )

  const compact = clip(
    [
      "## Quality bar (armed — violations WILL be rejected)",
      rules.map((rule) => String(rule.id)).join(" · "),
      "Write to these rules the first time; fixHints arrive with any finding.",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
    COMPACT_CAP,
  )

  const judge = clip(
    [
      "## Standing quality contract (deterministic rules armed in this workspace)",
      ...rules.map((rule) => `- ${rule.id}: ${rule.description}`),
      ...(boundaries.length > 0 ? ["", ...boundaries] : []),
      "",
      "These rules are enforced by earlier gates — do NOT re-litigate style. DO treat EVASION of the contract (weakened or skipped tests, disabled rules, outputs shaped to satisfy a check) as dishonesty.",
    ].join("\n"),
    JUDGE_CAP,
  )

  return Option.some({ full, compact, judge })
}
