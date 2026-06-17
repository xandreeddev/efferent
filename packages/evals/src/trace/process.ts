import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { costUsd } from "@xandreed/sdk-core"

/**
 * Build eval data by reading the collected spans — NOT a parallel metrics
 * store. Each `eval.case` span carries the scores (`eval.score.*`, `eval.mean`,
 * `eval.ok`); its descendant `llm.generate` spans carry tokens + model (→ cost);
 * its descendant `agent.turn` spans count the steps; its enclosing `eval.run`
 * span carries the config. Pure over `ReadableSpan[]` → unit-testable with
 * synthetic spans, no LLM/Docker.
 */

type Attrs = ReadableSpan["attributes"]
const numAttr = (a: Attrs, k: string): number | undefined =>
  typeof a[k] === "number" ? (a[k] as number) : undefined
const strAttr = (a: Attrs, k: string): string | undefined =>
  typeof a[k] === "string" ? (a[k] as string) : undefined
const boolAttr = (a: Attrs, k: string): boolean | undefined =>
  typeof a[k] === "boolean" ? (a[k] as boolean) : undefined

const hrToMs = (hr: readonly [number, number]): number => hr[0] * 1000 + hr[1] / 1e6

export interface CaseAgg {
  readonly suite: string
  readonly name: string
  readonly configName: string
  readonly ok: boolean
  readonly mean: number
  readonly scores: ReadonlyArray<{ readonly name: string; readonly score: number }>
  readonly steps: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly costUsd?: number
  readonly wallMs: number
}

export interface SuiteAgg {
  readonly suite: string
  readonly mean: number
  readonly passRate: number
  readonly cases: ReadonlyArray<CaseAgg>
}

export interface RunAgg {
  readonly configName: string
  readonly suites: ReadonlyArray<SuiteAgg>
}

const spanId = (s: ReadableSpan): string => s.spanContext().spanId
const parentId = (s: ReadableSpan): string | undefined => s.parentSpanContext?.spanId

const average = (ns: ReadonlyArray<number>): number =>
  ns.length === 0 ? 0 : ns.reduce((a, b) => a + b, 0) / ns.length

/** One LLM call's contribution: usage + (when priced) cost. */
const llmContribution = (
  s: ReadableSpan,
): { input: number; output: number; cacheRead: number; cost?: number } => {
  const a = s.attributes
  const input = numAttr(a, "gen_ai.usage.input_tokens") ?? 0
  const output = numAttr(a, "gen_ai.usage.output_tokens") ?? 0
  const cacheRead = numAttr(a, "gen_ai.usage.cache_read_tokens") ?? 0
  const provider = strAttr(a, "gen_ai.system")
  const model = strAttr(a, "gen_ai.request.model")
  const cost =
    provider !== undefined && model !== undefined
      ? costUsd(`${provider}:${model}`, {
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
        })
      : undefined
  return { input, output, cacheRead, ...(cost !== undefined ? { cost } : {}) }
}

export const processSpans = (spans: ReadonlyArray<ReadableSpan>): ReadonlyArray<RunAgg> => {
  const byId = new Map<string, ReadableSpan>()
  const children = new Map<string, Array<ReadableSpan>>()
  for (const s of spans) {
    byId.set(spanId(s), s)
    const p = parentId(s)
    if (p !== undefined) {
      const list = children.get(p) ?? []
      list.push(s)
      children.set(p, list)
    }
  }

  // The config label for a case: walk ancestors to the enclosing eval.run span.
  const configFor = (s: ReadableSpan): string => {
    let cur: ReadableSpan | undefined = s
    while (cur !== undefined) {
      if (cur.name === "eval.run") return strAttr(cur.attributes, "config.name") ?? "run"
      const p = parentId(cur)
      cur = p !== undefined ? byId.get(p) : undefined
    }
    return "default"
  }

  // All descendants of a span (its subtree, excluding itself).
  const descendants = (s: ReadableSpan): Array<ReadableSpan> => {
    const out: Array<ReadableSpan> = []
    const stack = [...(children.get(spanId(s)) ?? [])]
    while (stack.length > 0) {
      const n = stack.pop()
      if (n === undefined) continue
      out.push(n)
      const kids = children.get(spanId(n))
      if (kids !== undefined) stack.push(...kids)
    }
    return out
  }

  const caseAggs: Array<CaseAgg> = []
  for (const s of spans) {
    if (s.name !== "eval.case") continue
    const a = s.attributes
    const suite = strAttr(a, "eval.suite") ?? "?"
    const name = strAttr(a, "eval.case") ?? "?"
    const mean = numAttr(a, "eval.mean") ?? 0
    const ok = boolAttr(a, "eval.ok") ?? false
    const scores: Array<{ name: string; score: number }> = []
    for (const [k, v] of Object.entries(a)) {
      if (k.startsWith("eval.score.") && typeof v === "number") {
        scores.push({ name: k.slice("eval.score.".length), score: v })
      }
    }

    const subtree = descendants(s)
    let input = 0
    let output = 0
    let cacheRead = 0
    let cost: number | undefined = undefined
    let steps = 0
    for (const d of subtree) {
      // Match on the stable `agent.kind` attribute, not the (renamable) span
      // name — the same identity the Grafana dashboards filter on.
      const kind = strAttr(d.attributes, "agent.kind")
      if (kind === "turn") steps++
      if (kind === "llm") {
        const c = llmContribution(d)
        input += c.input
        output += c.output
        cacheRead += c.cacheRead
        if (c.cost !== undefined) cost = (cost ?? 0) + c.cost
      }
    }

    caseAggs.push({
      suite,
      name,
      configName: configFor(s),
      ok,
      mean,
      scores,
      steps,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      ...(cost !== undefined ? { costUsd: cost } : {}),
      wallMs: hrToMs(s.duration),
    })
  }

  // Group: config → suite → cases.
  const byConfig = new Map<string, Array<CaseAgg>>()
  for (const c of caseAggs) {
    const list = byConfig.get(c.configName) ?? []
    list.push(c)
    byConfig.set(c.configName, list)
  }

  const runs: Array<RunAgg> = []
  for (const [configName, cs] of byConfig) {
    const bySuite = new Map<string, Array<CaseAgg>>()
    for (const c of cs) {
      const list = bySuite.get(c.suite) ?? []
      list.push(c)
      bySuite.set(c.suite, list)
    }
    const suites: Array<SuiteAgg> = []
    for (const [suite, scases] of bySuite) {
      suites.push({
        suite,
        mean: average(scases.map((c) => c.mean)),
        passRate: average(scases.map((c) => (c.mean >= 0.6 ? 1 : 0))),
        cases: scases,
      })
    }
    runs.push({ configName, suites })
  }
  return runs
}
