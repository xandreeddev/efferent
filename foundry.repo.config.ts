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

// packages/smith is post-foundry: it rides the same composition rules with
// ZERO baseline entries — every finding there is fresh and fails outright.
// packages/engine is the NEW LINE's kernel — same zero-baseline discipline.
const CHECKED = [
  ...LEGACY,
  "packages/smith/src/**",
  "packages/math/src/**",
  "packages/social/src/**",
  "packages/engine/src/**",
  "packages/providers/src/**",
  "packages/surface/src/**",
  "packages/canvas/src/**",
]

const config: typeof GateSuiteConfig.Encoded = {
  tsconfig: "tsconfig.json",
  typecheck: false,
  rules: [
    {
      rule: "effect/no-try-catch",
      include: [
        "packages/sdk-core/src/**",
        "packages/smith/src/**",
        "packages/math/src/**",
        "packages/engine/src/**",
        "packages/providers/src/**",
        "packages/surface/src/**",
        "packages/canvas/src/**",
      ],
    },
    { rule: "effect/no-let", include: CHECKED },
    { rule: "effect/no-loop-statements", include: CHECKED },
    { rule: "effect/no-nullable-return", include: CHECKED },
    { rule: "effect/match-over-tag-switch", include: CHECKED },
    { rule: "effect/no-as-any", include: CHECKED },
    { rule: "effect/no-parallel-interface", include: CHECKED },
    {
      rule: "effect/branded-id-fields",
      include: ["packages/sdk-core/src/entities/**", "packages/engine/src/domain/**"],
    },
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
        // The NEW LINE's agent kernel: entities, ports, the loop, the session
        // chassis. Pure — imports nothing internal, no provider SDKs, no IO.
        name: "engine",
        path: "packages/engine/src/**",
        canImport: [],
        externals: ["effect", "@effect/ai", "bun:test"],
      },
      {
        // The NEW LINE's edge: Layer impls of the engine's ports (provider
        // router, auth/settings stores, SQLite store, fs/shell).
        name: "providers",
        path: "packages/providers/src/**",
        canImport: ["engine"],
        externals: ["effect", "@effect/", "@xandreed/engine", "node:", "bun", "bun:"],
      },
      {
        // The NEW LINE's UI substrate: html template, sanitizer, validateUi,
        // protocol contract. Pure — effect only, nothing internal.
        name: "surface",
        path: "packages/surface/src/**",
        canImport: [],
        externals: ["effect", "bun:test"],
      },
      {
        // The ui-builder agent: render_ui through the surface gates, on the
        // engine chassis, providers at the edge. Never touches the old line.
        name: "canvas",
        path: "packages/canvas/src/**",
        canImport: ["engine", "providers", "surface"],
        externals: [
          "effect",
          "@effect/",
          "@xandreed/engine",
          "@xandreed/providers",
          "@xandreed/surface",
          "node:",
          "bun",
          "bun:",
        ],
      },
      {
        // The social engagement agent: draft-only toolkit, human review queue,
        // deterministic policy gates at write_draft + pre-post. MIGRATED to
        // the new line: engine + providers, never the old packages.
        name: "social",
        path: "packages/social/src/**",
        canImport: ["engine", "providers"],
        externals: [
          "effect",
          "@effect/",
          "@xandreed/engine",
          "@xandreed/providers",
          "playwright",
          "node:",
          "bun",
          "bun:",
        ],
      },
      {
        // The standalone math-practice product (docs/agents/education.md).
        // MIGRATED to the new line: engine + providers. Still renders through
        // the old web package's math views — TRANSITIONAL until those views
        // move into math/surface (then web dies with the old line).
        name: "math",
        path: "packages/math/src/**",
        canImport: ["engine", "providers", "web"],
        externals: [
          "effect",
          "@effect/",
          "@xandreed/engine",
          "@xandreed/providers",
          "@xandreed/web",
          "node:",
          "bun",
          "bun:",
        ],
      },
      {
        // The agent in the factory: drives foundry's forge with the efferent
        // coder as the Implementor. NEVER imports the cli ("efferent/") — and
        // the cli never imports smith, so the published bundle can't reach
        // foundry's `typescript` dependency through it.
        name: "smith",
        path: "packages/smith/src/**",
        canImport: ["core", "adapters", "foundry"],
        externals: [
          "effect",
          "@effect/",
          "@xandreed/sdk-core",
          "@xandreed/sdk-adapters",
          "@xandreed/foundry",
          "@opentui/",
          "solid-js",
          "node:",
          "bun",
          "bun:",
        ],
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
