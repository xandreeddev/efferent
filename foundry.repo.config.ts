import type { GateSuiteConfig } from "@xandreed/foundry/domain/Rules.js"

/**
 * The REPO-level gate suite, run as part of `bun run typecheck` (which is why
 * `typecheck: false` — tsc runs right beside it; no double program check).
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
  "packages/canvas/src/**",
  "packages/scenarios/src/**",
  "packages/smith/src/**",
  "packages/math/src/**",
  "packages/social/src/**",
]

const config: typeof GateSuiteConfig.Encoded = {
  tsconfig: "tsconfig.json",
  typecheck: false,
  rules: [
    { rule: "effect/no-try-catch", include: CHECKED },
    { rule: "effect/no-let", include: CHECKED },
    { rule: "effect/no-loop-statements", include: CHECKED },
    { rule: "effect/no-nullable-return", include: CHECKED },
    { rule: "effect/match-over-tag-switch", include: CHECKED },
    { rule: "effect/no-as-any", include: CHECKED },
    { rule: "effect/no-parallel-interface", include: CHECKED },
    {
      rule: "effect/branded-id-fields",
      include: ["packages/engine/src/domain/**", "packages/engine/src/spec/**"],
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
          "bun",
          "bun:",
        ],
      },
      {
        // The UI substrate: html template, sanitizers, validateUi, protocol
        // contract. Pure — effect only, nothing internal.
        name: "surface",
        path: "packages/surface/src/**",
        canImport: [],
        externals: ["effect", "bun:test"],
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
        // The ui-builder agent: render_ui through the surface gates, on the
        // engine chassis, providers at the edge.
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
        // Evals v3: scenario packs over agent worlds. The TOP of the graph —
        // packs may import the agents; nothing imports it.
        name: "scenarios",
        path: "packages/scenarios/src/**",
        canImport: ["engine", "providers", "surface", "foundry", "smith", "math", "social", "canvas"],
        externals: ["effect", "@effect/", "@xandreed/", "node:", "bun", "bun:"],
      },
    ],
  },
}

export default config
