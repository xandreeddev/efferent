import type { GateSuiteConfig } from "@xandreed/foundry/domain/Rules.js"
import {
  effectArchitecturePack,
  effectPack,
  qualityPack,
} from "@xandreed/foundry/gates/rules/packs.js"

/** The rule registry is what THIS module exports — no implicit builtins. */
export const rulePacks = [effectPack, qualityPack, effectArchitecturePack]

/**
 * The canonical repo profile: Smith and the developer scripts discover the
 * same contract, so a forge can never run against weaker defaults than CI.
 *
 * The old line (sdk-core / sdk-adapters / cli / web / evals) is DELETED —
 * every package below was born under these rules with a ZERO-entry baseline,
 * so any finding anywhere is fresh and fails outright. The committed baseline
 * file exists only as the ratchet mechanism's anchor and stays empty.
 *
 * Boundaries: bun-workspace cross-package imports are bare specifiers, so
 * dependency DIRECTION is expressed via each layer's `externals` allowlist —
 * a package may only name the internal packages beneath it.
 */
const CHECKED = [
  "packages/engine/src/**",
  "packages/providers/src/**",
  "packages/surface/src/**",
  "packages/ui-agent/src/**",
  "packages/canvas/src/**",
  "packages/scenarios/src/**",
  "packages/smith/src/**",
  "packages/math/src/**",
  "packages/social/src/**",
  "packages/issue-tracker-example/src/**",
]

const config: typeof GateSuiteConfig.Encoded = {
  tsconfig: "tsconfig.json",
  typecheck: true,
  rules: [
    { rule: "effect/no-try-catch", include: CHECKED },
    { rule: "effect/no-let", include: CHECKED },
    { rule: "effect/no-loop-statements", include: CHECKED },
    { rule: "effect/no-nullable-return", include: CHECKED },
    { rule: "effect/match-over-tag-switch", include: CHECKED },
    { rule: "effect/no-as-any", include: CHECKED },
    { rule: "effect/no-parallel-interface", include: CHECKED },
    { rule: "quality/no-skipped-tests", include: CHECKED },
    { rule: "quality/no-empty-catch", include: CHECKED },
    { rule: "architecture/no-raw-promise-core", include: CHECKED },
    { rule: "architecture/no-runtime-imports-core", include: CHECKED },
    { rule: "architecture/contracts-contain-no-behavior", include: CHECKED },
    { rule: "architecture/context-tags-live-in-ports", include: CHECKED },
    { rule: "architecture/layers-live-at-edges", include: CHECKED },
    {
      rule: "effect/branded-id-fields",
      include: ["packages/engine/src/domain/**", "packages/engine/src/spec/**"],
    },
  ],
  checks: [
    {
      name: "scripted-scenarios",
      command: "bun run scenarios",
      kind: "eval",
      timeoutMs: 900_000,
    },
  ],
  boundaries: {
    layers: [
      {
        // The agent kernel: entities, ports, the loop, the session chassis,
        // the spec module. Pure — imports nothing internal, no provider
        // SDKs, no IO.
        name: "engine",
        path: "packages/engine/src/**",
        canImport: [],
        externals: ["effect", "@effect/ai", "bun:test"],
      },
      {
        // The edge: Layer impls of the engine's ports (provider router,
        // auth/settings stores, SQLite store, fs/shell).
        name: "providers",
        path: "packages/providers/src/**",
        canImport: ["engine"],
        // @opentelemetry/: the OTLP exporter + span processor behind
        // TracingLive — observability is edge concern, so it lives here.
        externals: [
          "effect",
          "@effect/",
          "@opentelemetry/",
          "@xandreed/engine",
          "node:",
          "ws",
          "bun",
          "bun:",
        ],
      },
      {
        // Structured UI-agent domain and orchestration. It may use the engine
        // chassis but has no browser, filesystem, provider, or HTML imports.
        name: "ui-agent",
        path: "packages/ui-agent/src/**",
        canImport: ["engine"],
        externals: ["effect", "@effect/", "@xandreed/engine", "bun:test"],
      },
      {
        // The UI substrate: html template, sanitizers, validateUi, protocol
        // contract, and trusted structured compiler. It consumes UI-agent
        // data contracts; the UI agent never imports the renderer back.
        name: "surface",
        path: "packages/surface/src/**",
        canImport: ["ui-agent"],
        externals: ["effect", "@xandreed/ui-agent", "@dagrejs/dagre", "bun:test"],
      },
      {
        // The gate framework — the fixed point. Imports nothing internal.
        name: "foundry",
        path: "packages/foundry/src/**",
        canImport: [],
        externals: ["effect", "typescript", "node:", "bun:test"],
      },
      {
        // The spec-driven coder at the forge: engine loop + smith coding
        // toolkit as foundry's Implementor; gates outside the agent.
        name: "smith",
        path: "packages/smith/src/**",
        canImport: ["engine", "providers", "foundry"],
        externals: [
          "effect",
          "@effect/",
          "@xandreed/engine",
          "@xandreed/providers",
          "@xandreed/foundry",
          "@opentui/",
          "solid-js",
          "node:",
          "bun",
          "bun:",
        ],
      },
      {
        // The standalone math-practice product — owns its views/assets;
        // sanitizeMathml lives in surface.
        name: "math",
        path: "packages/math/src/**",
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
        // The social engagement agent: draft-only toolkit, human review
        // queue, deterministic policy gates at both chokepoints.
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
        // First host for the structured UI agent: adapters + browser delivery
        // around the UI-agent runtime and trusted Surface compiler.
        name: "canvas",
        path: "packages/canvas/src/**",
        canImport: ["engine", "providers", "surface", "ui-agent"],
        externals: [
          "effect",
          "@effect/",
          "@xandreed/engine",
          "@xandreed/providers",
          "@xandreed/surface",
          "@xandreed/ui-agent",
          "node:",
          "bun",
          "bun:",
        ],
      },
      {
        // Canonical Effect-native ports-and-adapters example and eval world.
        name: "issue-tracker-example",
        path: "packages/issue-tracker-example/src/**",
        canImport: [],
        externals: ["effect", "bun:test"],
      },
      {
        // Evals v3: scenario packs over agent worlds. The TOP of the graph —
        // packs may import the agents; nothing imports it.
        name: "scenarios",
        path: "packages/scenarios/src/**",
        canImport: ["engine", "providers", "surface", "ui-agent", "foundry", "smith", "math", "social", "canvas"],
        externals: ["effect", "@effect/", "@xandreed/", "playwright", "node:", "bun", "bun:"],
      },
    ],
  },
}

export default config
