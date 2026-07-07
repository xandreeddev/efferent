import type { GateSuiteConfig } from "@xandreed/foundry/domain/Rules.js"

/**
 * The REPO-level gate suite, run as part of `bun run typecheck` (which is why
 * `typecheck: false` — tsc runs right beside it; no double program check).
 *
 * Two tiers of strictness:
 * - `effect/no-try-catch` on sdk-core is ZERO-tolerance (this is the old
 *   `scripts/banTryCatch.ts`, generalized and retired).
 * - The composition rules (`no-let`, `no-loop-statements`,
 *   `no-nullable-return`, `match-over-tag-switch`, `no-as-any`,
 *   `no-parallel-interface`) run over the pre-foundry packages behind the
 *   committed RATCHET baseline (`packages/foundry/baselines/repo.json`):
 *   existing violations are grandfathered, any NEW one fails, and the
 *   baseline may only shrink. This is how the old code migrates
 *   incrementally instead of big-bang.
 *
 * Boundaries: bun-workspace cross-package imports are bare specifiers, so
 * dependency DIRECTION is expressed via each layer's `externals` allowlist —
 * a package may only name the internal packages beneath it.
 */
const LEGACY = [
  "packages/sdk-core/src/**",
  "packages/sdk-adapters/src/**",
  "packages/cli/src/**",
  "packages/web/src/**",
  "packages/evals/src/**",
]

const config: typeof GateSuiteConfig.Encoded = {
  tsconfig: "tsconfig.json",
  typecheck: false,
  rules: [
    { rule: "effect/no-try-catch", include: ["packages/sdk-core/src/**"] },
    { rule: "effect/no-let", include: LEGACY },
    { rule: "effect/no-loop-statements", include: LEGACY },
    { rule: "effect/no-nullable-return", include: LEGACY },
    { rule: "effect/match-over-tag-switch", include: LEGACY },
    { rule: "effect/no-as-any", include: LEGACY },
    { rule: "effect/no-parallel-interface", include: LEGACY },
    { rule: "effect/branded-id-fields", include: ["packages/sdk-core/src/entities/**"] },
  ],
  // Eval STRUCTURE as a gate: every packages/evals suite must declare ≥1
  // scorer + an explicit threshold and be registered in run.ts's SUITES —
  // an unregistered suite silently never runs.
  evalShape: {
    registry: "packages/evals/src/run.ts",
    suiteGlob: "packages/evals/src/suites/**/*.eval.ts",
  },
  boundaries: {
    layers: [
      {
        name: "core",
        path: "packages/sdk-core/src/**",
        canImport: [],
        externals: ["effect", "@effect/ai", "node:path", "bun:test"],
      },
      {
        name: "web",
        path: "packages/web/src/**",
        canImport: [],
        externals: ["bun:test", "node:"],
      },
      {
        name: "adapters",
        path: "packages/sdk-adapters/src/**",
        canImport: ["core"],
        externals: ["effect", "@effect/", "@xandreed/sdk-core", "node:", "bun", "bun:"],
      },
      {
        name: "evals",
        path: "packages/evals/src/**",
        canImport: ["core", "adapters"],
        // @opentelemetry/: the in-memory span collector (trace-first reports).
        // typescript: scenario support tooling. evals→efferent/* imports are
        // NOT allowed here — they contradict the package's documented rule
        // and live in the ratchet baseline as debt to burn down.
        externals: [
          "effect",
          "@effect/",
          "@xandreed/sdk-core",
          "@xandreed/sdk-adapters",
          "@opentelemetry/",
          "typescript",
          "node:",
          "bun",
          "bun:",
        ],
      },
      {
        name: "foundry",
        path: "packages/foundry/src/**",
        canImport: [],
        externals: ["effect", "typescript", "node:", "bun:test"],
      },
      {
        name: "cli",
        path: "packages/cli/src/**",
        canImport: ["core", "adapters", "web", "evals", "foundry"],
        externals: [
          "effect",
          "@effect/",
          "@xandreed/",
          "efferent/",
          "@opentui/",
          "solid-js",
          "web-tree-sitter",
          "node:",
          "bun",
          "bun:",
        ],
      },
    ],
  },
}

export default config
