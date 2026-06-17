#!/usr/bin/env bun
/**
 * Codegen: bake a static model catalogue from models.dev into
 * `../src/entities/modelCatalog.generated.ts`.
 *
 * Anthropic's `/v1/models` returns no context length and OpenAI's omits it too,
 * so the live `ModelRegistry` can't learn a model's real window at runtime. This
 * script snapshots the community catalogue at https://models.dev/api.json — the
 * authoritative source for per-model `context` / `output` limits — for the three
 * providers efferent talks to, so `contextWindowFor` can return the truth
 * instead of a heuristic guess.
 *
 * Run: `bun run generate-models` (from agent/ root). Commit the regenerated file.
 *
 * NOT runtime code — this is a dev tool; it lives outside `src/` so the
 * "no IO in core/src" rule doesn't apply. The generated output is pure data.
 */

const PROVIDERS = ["anthropic", "google", "openai"] as const

// OpenCode Go models are not on models.dev; merge them manually.
const OPENCODE_CATALOG: Record<string, { contextWindow: number; output: number }> = {
  "opencode:deepseek-v4-pro": { contextWindow: 128000, output: 8192 },
  "opencode:deepseek-v4-flash": { contextWindow: 128000, output: 8192 },
  "opencode:glm-5": { contextWindow: 128000, output: 8192 },
  "opencode:glm-5.1": { contextWindow: 128000, output: 8192 },
  "opencode:kimi-k2.5": { contextWindow: 256000, output: 8192 },
  "opencode:kimi-k2.6": { contextWindow: 256000, output: 8192 },
  "opencode:mimo-v2.5": { contextWindow: 128000, output: 8192 },
  "opencode:mimo-v2.5-pro": { contextWindow: 128000, output: 8192 },
  "opencode:minimax-m2.5": { contextWindow: 200000, output: 8192 },
  "opencode:minimax-m2.7": { contextWindow: 200000, output: 8192 },
  "opencode:minimax-m3": { contextWindow: 200000, output: 8192 },
  "opencode:qwen3.6-plus": { contextWindow: 128000, output: 8192 },
  "opencode:qwen3.7-max": { contextWindow: 128000, output: 8192 },
}

interface ModelsDevModel {
  readonly name?: string
  readonly tool_call?: boolean
  readonly limit?: { readonly context?: number; readonly output?: number }
  /** USD per 1M tokens. `cache_read` ≈ cached-input rate (falls back to input). */
  readonly cost?: {
    readonly input?: number
    readonly output?: number
    readonly cache_read?: number
  }
}

interface CatalogCost {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
}

interface CatalogEntry {
  readonly contextWindow: number
  readonly maxTokens: number
  readonly cost?: CatalogCost
}

/** Pull per-1M-token pricing when models.dev reports both input + output. */
const parseCost = (m: ModelsDevModel): CatalogCost | undefined => {
  const c = m.cost
  if (c === undefined || typeof c.input !== "number" || typeof c.output !== "number") {
    return undefined
  }
  return {
    input: c.input,
    output: c.output,
    cacheRead: typeof c.cache_read === "number" ? c.cache_read : c.input,
  }
}

const main = async (): Promise<void> => {
  console.log("Fetching https://models.dev/api.json …")
  const res = await fetch("https://models.dev/api.json")
  if (!res.ok) throw new Error(`models.dev returned ${res.status}`)
  const data = (await res.json()) as Record<
    string,
    { models?: Record<string, ModelsDevModel> }
  >

  const catalog: Record<string, CatalogEntry> = {}
  for (const provider of PROVIDERS) {
    const models = data[provider]?.models ?? {}
    for (const [modelId, m] of Object.entries(models)) {
      // Only tool-capable models with a known context window are useful to us.
      if (m.tool_call !== true) continue
      const context = m.limit?.context
      if (typeof context !== "number" || context <= 0) continue
      const cost = parseCost(m)
      catalog[`${provider}:${modelId}`] = {
        contextWindow: context,
        maxTokens: m.limit?.output ?? 0,
        ...(cost !== undefined ? { cost } : {}),
      }
    }
  }

  for (const [k, v] of Object.entries(OPENCODE_CATALOG)) {
    catalog[k] = { contextWindow: v.contextWindow, maxTokens: v.output }
  }

  const keys = Object.keys(catalog).sort()
  const date = new Date().toISOString().slice(0, 10)
  const body = keys
    .map((k) => {
      const e = catalog[k]!
      const cost =
        e.cost !== undefined
          ? `, cost: { input: ${e.cost.input}, output: ${e.cost.output}, cacheRead: ${e.cost.cacheRead} }`
          : ""
      return `  ${JSON.stringify(k)}: { contextWindow: ${e.contextWindow}, maxTokens: ${e.maxTokens}${cost} },`
    })
    .join("\n")

  const out = `// AUTO-GENERATED — do not edit by hand.
// Source: https://models.dev/api.json (snapshot ${date})
// Regenerate: \`bun run generate-models\` (packages/core/scripts/generateModelCatalog.ts).
//
// Keyed by "<provider>:<modelId>". Carries each model's real context window,
// max output tokens, and (when models.dev reports it) USD-per-1M-token pricing
// for the three providers efferent talks to. Consumed by \`contextWindowFor\`
// and \`costUsd\` in ./Model.ts (both fall back gracefully for unknown ids).

export interface CatalogEntry {
  readonly contextWindow: number
  readonly maxTokens: number
  /** USD per 1M tokens (models.dev). Absent when the source omits pricing. */
  readonly cost?: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
  }
}

export const MODEL_CATALOG: Record<string, CatalogEntry> = {
${body}
}
`

  const target = new URL("../src/entities/modelCatalog.generated.ts", import.meta.url)
  await Bun.write(target, out)
  console.log(`Wrote ${keys.length} models → ${target.pathname}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
