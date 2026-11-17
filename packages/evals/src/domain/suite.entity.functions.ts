import { Option } from "effect"
import type { Gate } from "./suite.entity.js"

/**
 * What a gate needs said, the rest left to its default: the grader (`id@version`) and metric it reads, and a
 * minimum, a maximum or both (a gate with neither would pass any value, so the type asks for one).
 *
 * @public
 */
export type GateOptions = {
  readonly grader: string
  readonly metric: string
  /** How the metric is aggregated over a candidate's trials: the share that passed (default) or the mean. */
  readonly aggregate?: Gate["aggregate"]
  /** `blocking` (default) fails the suite; `diagnostic` is reported and fails nothing. */
  readonly mode?: Gate["mode"]
  /** Whether the gate passes only while every trial's reference was reviewed by a person. Default: true. */
  readonly requiresReviewedReference?: boolean
} & ({ readonly minimum: number; readonly maximum?: number } | { readonly minimum?: number; readonly maximum: number })

/**
 * A gate from what it needs said: `passRate`, `blocking` and a reviewed reference by default, each bound an
 * `Option`. `gate({ grader: "answer@1", metric: "holds", minimum: 0.8 })` is a blocking gate that at least 80 % of a
 * candidate's trials score `holds`, on references a person reviewed.
 *
 * @public
 */
export const gate = (options: GateOptions): Gate => ({
  grader: options.grader,
  metric: options.metric,
  aggregate: options.aggregate ?? "passRate",
  mode: options.mode ?? "blocking",
  minimum: Option.fromNullishOr(options.minimum),
  maximum: Option.fromNullishOr(options.maximum),
  requiresReviewedReference: options.requiresReviewedReference ?? true,
})
