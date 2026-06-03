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

interface ModelsDevModel {
  readonly name?: string
  readonly tool_call?: boolean
  readonly limit?: { readonly context?: number; readonly output?: number }
}

interface CatalogEntry {
  readonly contextWindow: number
  readonly maxTokens: number
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
      catalog[`${provider}:${modelId}`] = {
        contextWindow: context,
        maxTokens: m.limit?.output ?? 0,
      }
    }
  }

  const keys = Object.keys(catalog).sort()
  const date = new Date().toISOString().slice(0, 10)
  const body = keys
    .map((k) => {
      const e = catalog[k]!
      return `  ${JSON.stringify(k)}: { contextWindow: ${e.contextWindow}, maxTokens: ${e.maxTokens} },`
    })
    .join("\n")

  const out = `// AUTO-GENERATED — do not edit by hand.
// Source: https://models.dev/api.json (snapshot ${date})
// Regenerate: \`bun run generate-models\` (packages/core/scripts/generateModelCatalog.ts).
//
// Keyed by "<provider>:<modelId>". Carries each model's real context window and
// max output tokens for the three providers efferent talks to. Consumed by
// \`contextWindowFor\` in ./Model.ts (falls back to a heuristic for unknown ids).

export interface CatalogEntry {
  readonly contextWindow: number
  readonly maxTokens: number
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
