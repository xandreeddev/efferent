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
  "packages/core/src/**",
  "packages/evals/src/**",
  "packages/plugin-agent-loop/src/**",
  "packages/runtime/src/**",
  "packages/sdk/src/**",
  "packages/tui/src/**",
  "packages/cli/src/**",
  "packages/plugin-context/src/**",
  "packages/plugin-memory/src/**",
  "packages/plugin-models/src/**",
  "packages/plugin-tools-local/src/**",
  "packages/plugin-policy-workspace/src/**",
  "packages/plugin-session-sqlite/src/**",
  "packages/plugin-telemetry/src/**",
  "packages/plugin-mcp/src/**",
  "packages/surface/src/**",
  "packages/ui-agent/src/**",
  "packages/canvas/src/**",
  "packages/scenarios/src/**",
  "packages/smith/src/**",
  "packages/math/src/**",
  "packages/social/src/**",
  "packages/issue-tracker-example/src/**",
  // The factory judges itself by the same profile (the dogfood).
  "packages/foundry/src/**",
]

/**
 * The declared TYPE-ERASURE boundary: the router wrapping arbitrary provider
 * services, the compat/codex clients speaking @effect/ai's generic surface,
 * the loop's prompt assembly, the bridge over dynamic MCP tools. `as never`
 * is the design there and nowhere else — a new one anywhere else fails.
 * Test scaffolding (scripted providers, stubbed ports) is out of scope.
 */
const ERASURE_BOUNDARY = [
  "packages/plugin-models/src/llm/router.ts",
  "packages/plugin-models/src/llm/compat.ts",
  "packages/plugin-models/src/llm/openAiCodex.ts",
  "packages/plugin-models/src/llm/providers.ts",
  "packages/plugin-agent-loop/src/loop.ts",
  "packages/core/src/mcp/bridge.ts",
  "packages/plugin-tools-local/src/plugin.adapter.ts",
]
const TEST_SCAFFOLDING = ["**/*.test.ts", "**/*.test.tsx", "**/testing.ts", "packages/scenarios/src/**"]

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
    {
      rule: "effect/no-as-never",
      include: CHECKED,
      exclude: [...ERASURE_BOUNDARY, ...TEST_SCAFFOLDING],
    },
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
      include: ["packages/core/src/domain/**", "packages/core/src/spec/**"],
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
    layers: [{name:"evals",path:"packages/evals/src/**",canImport:["core"],externals:["effect","@xandreed/core","node:","bun:test"]},
      {
            "name": "canvas",
            "path": "packages/canvas/src/**",
            "canImport": [
                  "surface",
                  "ui-agent",
                  "core",
                  "plugin-session-sqlite",
                  "plugin-telemetry",
                  "plugin-models"
            ],
            "externals": ["@xandreed/sdk", "@xandreed/runtime",
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@alpinejs/csp",
                  "@xandreed/surface",
                  "@xandreed/ui-agent",
                  "@xandreed/core",
                  "@xandreed/plugin-session-sqlite",
                  "@xandreed/plugin-telemetry",
                  "@xandreed/plugin-models"
            ]
      },
      {
            "name": "cli",
            "path": "packages/cli/src/**",
            "canImport": [
                  "core",
                  "sdk",
                  "runtime",
                  "smith",
                  "tui",
                  "plugin-models"
            ],
            "externals": ["@xandreed/plugin-tools-local",
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "@xandreed/sdk",
                  "@xandreed/runtime",
                  "@xandreed/smith",
                  "@xandreed/tui",
                  "@xandreed/plugin-models"
            ]
      },
      {
            "name": "core",
            "path": "packages/core/src/**",
            "canImport": [],
            "externals": [
                  "effect",
                  "@effect/ai",
                  "bun:test"
            ]
      },
      {
            "name": "foundry",
            "path": "packages/foundry/src/**",
            "canImport": [],
            "externals": [
                  "effect",
                  "typescript",
                  "node:",
                  "bun:test"
            ]
      },
      {
            "name": "issue-tracker-example",
            "path": "packages/issue-tracker-example/src/**",
            "canImport": [
                  "foundry"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/foundry"
            ]
      },
      {
            "name": "math",
            "path": "packages/math/src/**",
            "canImport": [
                  "surface",
                  "core",
                  "plugin-agent-loop",
                  "plugin-tools-local",
                  "plugin-session-sqlite",
                  "plugin-telemetry",
                  "plugin-models"
            ],
            "externals": ["@xandreed/sdk", "@xandreed/runtime",
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/surface",
                  "@xandreed/core",
                  "@xandreed/plugin-agent-loop",
                  "@xandreed/plugin-tools-local",
                  "@xandreed/plugin-session-sqlite",
                  "@xandreed/plugin-telemetry",
                  "@xandreed/plugin-models"
            ]
      },
      {
            "name": "plugin-agent-loop",
            "path": "packages/plugin-agent-loop/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core"
            ]
      },
      {
            "name": "plugin-context",
            "path": "packages/plugin-context/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core"
            ]
      },
      {
            "name": "plugin-mcp",
            "path": "packages/plugin-mcp/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "ws"
            ]
      },
      {
            "name": "plugin-memory",
            "path": "packages/plugin-memory/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core"
            ]
      },
      {
            "name": "plugin-models",
            "path": "packages/plugin-models/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "ws"
            ]
      },
      {
            "name": "plugin-policy-workspace",
            "path": "packages/plugin-policy-workspace/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core"
            ]
      },
      {
            "name": "plugin-session-sqlite",
            "path": "packages/plugin-session-sqlite/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "ws"
            ]
      },
      {
            "name": "plugin-telemetry",
            "path": "packages/plugin-telemetry/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "@opentelemetry/exporter-metrics-otlp-http",
                  "@opentelemetry/exporter-trace-otlp-http",
                  "@opentelemetry/sdk-metrics",
                  "@opentelemetry/sdk-trace-base"
            ]
      },
      {
            "name": "plugin-tools-local",
            "path": "packages/plugin-tools-local/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "ws"
            ]
      },
      {
            "name": "runtime",
            "path": "packages/runtime/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core"
            ]
      },
      {
            "name": "scenarios",
            "path": "packages/scenarios/src/**",
            "canImport": [
                  "canvas",
                  "foundry",
                  "math",
                  "smith",
                  "core",
                  "plugin-agent-loop",
                  "plugin-tools-local",
                  "plugin-session-sqlite",
                  "plugin-mcp",
                  "plugin-models",
                  "ui-agent",
                  "social"
            ],
            "externals": ["@xandreed/sdk","@xandreed/evals",
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@opentui/core",
                  "@xandreed/canvas",
                  "@xandreed/foundry",
                  "@xandreed/math",
                  "@xandreed/smith",
                  "playwright",
                  "@xandreed/core",
                  "@xandreed/plugin-agent-loop",
                  "@xandreed/plugin-tools-local",
                  "@xandreed/plugin-session-sqlite",
                  "@xandreed/plugin-mcp",
                  "@xandreed/plugin-models",
                  "@xandreed/ui-agent",
                  "@xandreed/social"
            ]
      },
      {
            "name": "sdk-tests",
            "path": "packages/sdk/src/**/*.test.ts",
            "canImport": [
                  "sdk",
                  "core",
                  "runtime",
                  "plugin-memory",
                  "plugin-session-sqlite"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "@xandreed/runtime",
                  "@xandreed/plugin-memory",
                  "@xandreed/plugin-session-sqlite",
                  "@xandreed/plugin-memory",
                  "@xandreed/plugin-session-sqlite"
            ]
      },
      {
            "name": "sdk",
            "path": "packages/sdk/src/**",
            "canImport": [
                  "core",
                  "runtime"
            ],
            "externals": [
                  "effect",
                  "@xandreed/core",
                  "@xandreed/runtime",
                  "bun:test"
            ]
      },
      {
            "name": "smith",
            "path": "packages/smith/src/**",
            "canImport": [
                  "foundry",
                  "core",
                  "plugin-agent-loop",
                  "plugin-tools-local",
                  "plugin-session-sqlite",
                  "plugin-telemetry",
                  "plugin-mcp",
                  "plugin-models",
                  "plugin-policy-workspace",
                  "sdk",
                  "plugin-context",
                  "plugin-memory"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@opentui/core",
                  "@opentui/solid",
                  "@xandreed/foundry",
                  "solid-js",
                  "@xandreed/core",
                  "@xandreed/plugin-agent-loop",
                  "@xandreed/plugin-tools-local",
                  "@xandreed/plugin-session-sqlite",
                  "@xandreed/plugin-telemetry",
                  "@xandreed/plugin-mcp",
                  "@xandreed/plugin-models",
                  "@xandreed/plugin-policy-workspace",
                  "@xandreed/sdk",
                  "@xandreed/plugin-context",
                  "@xandreed/plugin-memory"
            ]
      },
      {
            "name": "social",
            "path": "packages/social/src/**",
            "canImport": [
                  "core",
                  "plugin-agent-loop",
                  "plugin-telemetry",
                  "plugin-models"
            ],
            "externals": ["@xandreed/sdk", "@xandreed/runtime", "@xandreed/plugin-session-sqlite",
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "playwright",
                  "@xandreed/core",
                  "@xandreed/plugin-agent-loop",
                  "@xandreed/plugin-telemetry",
                  "@xandreed/plugin-models"
            ]
      },
      {
            "name": "surface",
            "path": "packages/surface/src/**",
            "canImport": [
                  "ui-agent"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@dagrejs/dagre",
                  "@xandreed/ui-agent"
            ]
      },
      {
            "name": "tui",
            "path": "packages/tui/src/**",
            "canImport": [
                  "core",
                  "sdk"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "@xandreed/sdk",
                  "@opentui/core",
                  "@opentui/solid",
                  "solid-js"
            ]
      },
      {
            "name": "ui-agent",
            "path": "packages/ui-agent/src/**",
            "canImport": [
                  "core",
                  "plugin-agent-loop"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "@xandreed/plugin-agent-loop"
            ]
      }
],
  },
}

export default config
