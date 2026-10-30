import type { GateSuiteConfig } from "./src/domain/Rules.js"
import { effectPack } from "./src/gates/rules/packs.js"

/**
 * Foundry's SELF-CHECK — the dogfood: `bun run foundry check` must be clean
 * on foundry's own source, in CI, always. The layering below is the
 * package's architecture, enforced structurally.
 *
 * The rule registry is what THIS module exports — the platform ships no
 * implicit builtins; even foundry names its own pack.
 */
export const rulePacks = [effectPack]

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
      // Each folder's tests come before it (the first match wins): they may
      // import what the folder may, and `bun:test`, which no source imports.
      { name: "domain-tests", path: "src/domain/**/*.test.ts", canImport: ["domain"], externals: ["effect", "bun:test"] },
      { name: "domain", path: "src/domain/**", canImport: [], externals: ["effect"] },
      { name: "ports", path: "src/ports/**", canImport: ["domain"], externals: ["effect"] },
      { name: "pipeline-tests", path: "src/pipeline/**/*.test.ts", canImport: ["pipeline", "domain", "ports"], externals: ["effect", "bun:test"] },
      { name: "pipeline", path: "src/pipeline/**", canImport: ["domain", "ports"], externals: ["effect"] },
      {
        name: "gates-tests",
        path: "src/gates/**/*.test.ts",
        canImport: ["gates", "domain", "ports"],
        externals: ["effect", "effect/testing", "typescript", "node:", "bun:test"],
      },
      { name: "gates", path: "src/gates/**", canImport: ["domain", "ports"], externals: ["effect", "typescript", "node:"] },
      { name: "adapters-tests", path: "src/adapters/**/*.test.ts", canImport: ["adapters", "domain", "ports"], externals: ["effect", "node:", "bun:test"] },
      { name: "adapters", path: "src/adapters/**", canImport: ["domain", "ports"], externals: ["effect", "node:"] },
      {
        name: "cli-tests",
        path: "src/cli/**/*.test.ts",
        canImport: ["cli", "domain", "ports", "pipeline", "gates", "adapters"],
        externals: ["effect", "node:", "bun:test"],
      },
      { name: "cli", path: "src/cli/**", canImport: ["domain", "ports", "pipeline", "gates", "adapters"], externals: ["effect", "node:"] },
    ],
  },
}

export default config
