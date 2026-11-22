import { Array as Arr, Option, Order } from "effect"
import type { FileDiff } from "../diff.entity.js"
import { FINDINGS_SHOWN } from "../review-report.entity.js"
import { FINDING_ORDER } from "../review-report.entity.functions.js"
import { mergeFindings } from "../vote.entity.functions.js"
import type { GoldCase, GoldId, RecordedFinding, Replayed } from "./review-eval.entity.js"

/** A review's key in the recordings: the pull request and the first eight digits of the commit reviewed (`418-eaea24a5`). */
export const reviewKeyOf = (gold: Pick<GoldCase, "pr" | "reviewSha">): string => `${gold.pr}-${gold.reviewSha.slice(0, 8)}`

/** The known defects some of the findings were matched to, each once, in code-unit order. */
const goldsOf = (findings: ReadonlyArray<RecordedFinding>): ReadonlyArray<GoldId> =>
  Arr.sort(Arr.dedupe(findings.flatMap((finding) => (finding.judged === null ? [] : [finding.judged]))), Order.String)

/**
 * A review's recorded findings as a review with no check shows them: merged into buckets by the reviewer's own
 * `mergeFindings` (the vote off, as the command line runs) over the diffs given, each kept bucket's best finding in the
 * report's order (`FINDING_ORDER`: severity, then path, then line), the first `FINDINGS_SHOWN` shown. A known defect
 * is shown when a shown bucket's best finding, the one the report prints, was matched to it: another finding of the
 * bucket the person never reads. A change to the merge, to which finding is a bucket's best, or to the order moves
 * `shown`; nothing the reviewer does now moves `found`, which is the recorded draw's.
 */
export const replayed = (findings: ReadonlyArray<RecordedFinding>, files: ReadonlyArray<FileDiff>): Replayed => {
  const kept = mergeFindings(findings, files, { vote: false }).filter((bucket) => bucket.kept)
  const matched = new Map(findings.map((finding) => [`${finding.turn}/${finding.number}`, finding]))
  const shown = Arr.sort(kept, Order.mapInput(FINDING_ORDER, (bucket: (typeof kept)[number]) => bucket.best)).slice(0, FINDINGS_SHOWN)
  const printed = shown.flatMap((bucket) => Option.toArray(Option.fromNullishOr(matched.get(`${bucket.best.turn}/${bucket.best.number}`))))
  return { found: goldsOf(findings), shown: goldsOf(printed), findings: findings.length, kept: kept.length }
}

/** How a replay scores one known defect: whether some finding matched it, and whether a shown bucket holds one that does. */
export const goldScore = (replay: Replayed, gold: GoldId): { readonly found: boolean; readonly shown: boolean } => ({
  found: replay.found.includes(gold),
  shown: replay.shown.includes(gold),
})
