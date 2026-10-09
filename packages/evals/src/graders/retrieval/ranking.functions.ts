import { Option } from "effect"

/** Unknown relevance remains unavailable. Duplicate hits retain rank but gain no credit. */
export const rankingMetrics = (retrieved: ReadonlyArray<string>, labels: Readonly<Record<string, number>>, k: number, observedGrades?: ReadonlyArray<number>) => {
  const hits = retrieved.slice(0, k)
  const grades = observedGrades ? observedGrades.slice(0, k) : hits.map((id, index) => hits.indexOf(id) !== index ? 0 : labels[id] ?? 0)
  const positives = Object.entries(labels).filter(([, grade]) => grade > 0)
  const matched = new Set(hits.filter((_, index) => (grades[index] ?? 0) > 0)).size
  const dcg = (values: ReadonlyArray<number>) => values.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0)
  const ideal = dcg(positives.map(([, grade]) => grade).sort((a, b) => b - a).slice(0, k))
  const first = grades.findIndex((grade) => grade > 0)
  const judged = hits.every((id) => Object.hasOwn(labels, id))
  return {
    hit: positives.length ? Option.some(matched > 0 ? 1 : 0) : Option.none<number>(),
    precision: judged && hits.length ? Option.some(grades.filter((grade) => grade > 0).length / hits.length) : Option.none<number>(),
    recall: positives.length ? Option.some(matched / positives.length) : Option.none<number>(),
    mrr: positives.length ? Option.some(first < 0 ? 0 : 1 / (first + 1)) : Option.none<number>(),
    ndcg: judged && ideal > 0 ? Option.some(dcg(grades) / ideal) : Option.none<number>(),
    anchorNdcg: ideal > 0 ? Option.some(dcg(grades) / ideal) : Option.none<number>(),
    unjudged: hits.filter((id) => !Object.hasOwn(labels, id)).length,
    duplicates: hits.length - new Set(hits).size,
  }
}
