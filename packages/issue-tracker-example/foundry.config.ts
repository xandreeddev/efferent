import type { GateSuiteConfig } from "@xandreed/foundry"
import {
  effectArchitecturePack,
  effectPack,
  qualityPack,
} from "@xandreed/foundry"

export const rulePacks = [effectPack, qualityPack, effectArchitecturePack]

const CORE = ["src/domain/**", "src/usecases/**"]
const ALL = ["src/**"]

const config: typeof GateSuiteConfig.Encoded = {
  tsconfig: "tsconfig.json",
  typecheck: true,
  rules: [
    { rule: "effect/no-try-catch", include: ALL },
    { rule: "effect/no-let", include: ALL },
    { rule: "effect/no-loop-statements", include: ALL },
    { rule: "effect/no-nullable-return", include: ALL },
    { rule: "effect/match-over-tag-switch", include: ALL },
    { rule: "effect/no-as-any", include: ALL },
    { rule: "effect/no-parallel-interface", include: ALL },
    { rule: "quality/no-skipped-tests", include: ALL },
    { rule: "quality/no-empty-catch", include: ALL },
    { rule: "architecture/no-raw-promise-core", include: CORE },
    { rule: "architecture/no-runtime-imports-core", include: CORE },
    { rule: "architecture/contracts-contain-no-behavior", include: CORE },
    { rule: "architecture/context-tags-live-in-ports", include: ALL },
    { rule: "architecture/layers-live-at-edges", include: CORE },
  ],
  boundaries: {
    layers: [
      { name: "domain", path: "src/domain/**", canImport: [], externals: ["effect", "bun:test"] },
      { name: "ports", path: "src/ports/**", canImport: ["domain"], externals: ["effect"] },
      { name: "usecases", path: "src/usecases/**", canImport: ["domain", "ports"], externals: ["effect", "bun:test"] },
      { name: "adapters", path: "src/adapters/**", canImport: ["domain", "ports"], externals: ["effect", "bun:test"] },
      { name: "main", path: "src/main.ts", canImport: ["domain", "ports", "usecases", "adapters"], externals: ["effect"] },
      { name: "index", path: "src/index.ts", canImport: ["domain", "ports", "usecases", "adapters", "main"], externals: [] }
    ]
  }
}

export default config
