import type { GateSuiteConfig } from "./src/domain/Rules.js"

/**
 * Foundry's SELF-CHECK — the dogfood: `bun run foundry check` must be clean
 * on foundry's own source, in CI, always. The layering below is the
 * package's architecture, enforced structurally.
 */
const config: typeof GateSuiteConfig.Encoded = {
  tsconfig: "tsconfig.json",
  rules: [
    { rule: "effect/no-try-catch", include: ["src/**/*.ts"] },
    { rule: "effect/no-let", include: ["src/**/*.ts"] },
    { rule: "effect/no-loop-statements", include: ["src/**/*.ts"] },
    { rule: "effect/no-as-any", include: ["src/**/*.ts"] },
    { rule: "effect/match-over-tag-switch", include: ["src/**/*.ts"] },
    { rule: "effect/no-nullable-return", include: ["src/**/*.ts"] },
    { rule: "effect/branded-id-fields", include: ["src/domain/**"] },
    { rule: "effect/no-parallel-interface", include: ["src/**/*.ts"] },
  ],
  boundaries: {
    layers: [
      { name: "domain", path: "src/domain/**", canImport: [], externals: ["effect", "bun:test"] },
      { name: "ports", path: "src/ports/**", canImport: ["domain"], externals: ["effect", "bun:test"] },
      {
        name: "pipeline",
        path: "src/pipeline/**",
        canImport: ["domain", "ports"],
        externals: ["effect", "bun:test"],
      },
      {
        name: "gates",
        path: "src/gates/**",
        canImport: ["domain", "ports"],
        externals: ["effect", "typescript", "node:", "bun:test"],
      },
      {
        name: "adapters",
        path: "src/adapters/**",
        canImport: ["domain", "ports"],
        externals: ["effect", "node:", "bun:test"],
      },
      {
        name: "cli",
        path: "src/cli/**",
        canImport: ["domain", "ports", "pipeline", "gates", "adapters"],
        externals: ["effect", "node:", "bun:test"],
      },
    ],
  },
}

export default config
