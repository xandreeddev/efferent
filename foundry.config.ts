import type { GateSuiteConfig } from "@xandreed/foundry/domain/Rules.js"
import {
  effectArchitecturePack,
  effectPack,
  qualityPack,
} from "@xandreed/foundry/gates/rules/packs.js"

/** The rule registry is what THIS module exports — no implicit builtins. */
export const rulePacks = [effectPack, qualityPack, effectArchitecturePack]

/**
 * The canonical repo profile: the developer scripts and CI discover the
 * same contract, so nothing runs against weaker defaults than CI.
 *
 * The old line (sdk-core / sdk-adapters / cli / web / evals) is DELETED —
 * every package below was born under these rules with a ZERO-entry baseline,
 * so any finding anywhere is fresh and fails outright. The committed baseline
 * file exists only as the ratchet mechanism's anchor and stays empty.
 *
 * Boundaries: bun-workspace cross-package imports are bare specifiers, so
 * dependency DIRECTION is expressed via each layer's `externals` allowlist —
 * a package may only name the internal packages beneath it. `effect` admits
 * Effect's core modules; each `effect/<module>` barrel that was its own v3
 * package (effect/ai was @effect/ai) is allowed by name, or all of them with
 * the raw `effect/` prefix beside `@effect/`. v4 no longer re-exports
 * fast-check, so property tests name it (core, plugin-models tests) where
 * v3 reached it through `effect`.
 */
const CHECKED = [
  "packages/core/src/**",
  "packages/evals/src/**",
  "packages/evals-cli/src/**",
  "packages/evals-langfuse/src/**",
  "packages/evals-langsmith/src/**",
  "packages/plugin-agent-loop/src/**",
  "packages/runtime/src/**",
  "packages/sdk/src/**",
  "packages/plugin-memory-window/src/**",
  "packages/plugin-memory-summary/src/**",
  "packages/plugin-memory-digest/src/**",
  "packages/plugin-tool-discovery/src/**",
  "packages/plugin-models/src/**",
  "packages/plugin-session-sqlite/src/**",
  "packages/plugin-sessions/src/**",
  "packages/plugin-tasks/src/**",
  "packages/plugin-render/src/**",
  "packages/plugin-workspace/src/**",
  "packages/plugin-telemetry/src/**",
  // The factory judges itself by the same profile (the dogfood).
  "packages/foundry/src/**",
]

/**
 * The declared TYPE-ERASURE boundary: the router wrapping arbitrary provider
 * services, the compat/codex clients speaking effect/ai's generic surface,
 * the loop's prompt assembly, the bridge over dynamic MCP tools, the npm
 * undici's fetch typed as the global one (its requests and responses have the
 * global fetch types' shape but are distinct classes, so nothing downstream
 * may rely on `instanceof Response` / `Headers`). `as never`
 * is the design there and nowhere else — a new one anywhere else fails.
 * Test scaffolding (scripted providers, stubbed ports) is out of scope.
 */
const ERASURE_BOUNDARY = [
  "packages/plugin-models/src/llm/router.ts",
  "packages/plugin-models/src/llm/compat.ts",
  "packages/plugin-models/src/llm/openAiCodex.ts",
  "packages/plugin-models/src/llm/providers.ts",
  "packages/plugin-models/src/transport/undici-fetch.adapter.ts",
  "packages/plugin-agent-loop/src/loop.ts",
  "packages/core/src/mcp/bridge.ts",
  "packages/plugin-tool-discovery/src/registry.adapter.ts",
]
const TEST_SCAFFOLDING = ["**/*.test.ts", "**/*.test.tsx", "**/testing.ts"]

/**
 * A package is gated, built and published only once it is listed by hand:
 * in CHECKED, in a boundaries layer below, in the build's `names`, in the
 * base tsconfig's `paths` and, for a plugin, in the plugin reference's
 * `firstParty`. The registration gate fails on every package one of them
 * misses, naming the list. The docs site is not a TypeScript package of the
 * framework, and foundry is development tooling: never built or published.
 */
const registration: NonNullable<typeof GateSuiteConfig.Encoded["registration"]> = {
  roots: ["packages"],
  exclude: ["packages/website"],
  registries: [
    { source: "rules", hint: 'add "{path}/src/**" to CHECKED in foundry.config.ts' },
    {
      source: "boundaries",
      hint: 'add a "{dir}" layer for "{path}/src/**" to boundaries.layers in foundry.config.ts, naming what it may import',
    },
    {
      source: "const",
      file: "scripts/build-packages.ts",
      name: "names",
      entry: "{dir}",
      exclude: ["packages/foundry"],
      hint: 'add "{dir}" to `names` in scripts/build-packages.ts; an unlisted package is never built, verified or published',
    },
    { source: "json-keys", file: "tsconfig.base.json", keys: ["compilerOptions", "paths"], entry: "{name}" },
    {
      source: "const",
      file: "scripts/generate-plugin-reference.ts",
      name: "firstParty",
      entry: "{name}",
      include: ["packages/plugin-*"],
      hint: "import {name} in scripts/generate-plugin-reference.ts and add its plugins to `firstParty`",
    },
  ],
}

const config: typeof GateSuiteConfig.Encoded = {
  tsconfig: "tsconfig.json",
  typecheck: true,
  // `.foundry/baseline.json` is only the ratchet's anchor: it grandfathers
  // nothing, and `bun run typecheck` fails while it holds a fingerprint.
  baseline: "empty",
  registration,
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
  checks: [],
  boundaries: {
    layers: [
      { name: "evals-cli", path: "packages/evals-cli/src/**", canImport: ["evals"], externals: ["effect", "@xandreed/evals", "node:", "tsx/esm/api", "bun:test"] },
      { name: "evals-langfuse", path: "packages/evals-langfuse/src/**", canImport: ["evals"], externals: ["effect", "@xandreed/evals", "@langfuse/client", "node:", "bun:test"] },
      { name: "evals-langsmith", path: "packages/evals-langsmith/src/**", canImport: ["evals"], externals: ["effect", "@xandreed/evals", "langsmith", "node:", "bun:test"] },
      {name:"evals",path:"packages/evals/src/**",canImport:["core"],externals:["effect","effect/ai","@noble/hashes/","node:","bun:test"]},
      {
            "name": "core",
            "path": "packages/core/src/**",
            "canImport": [],
            "externals": [
                  "effect",
                  "effect/ai",
                  "fast-check",
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
            "name": "plugin-agent-loop",
            "path": "packages/plugin-agent-loop/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core"
            ]
      },
      {
            "name": "plugin-memory-window",
            "path": "packages/plugin-memory-window/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "@xandreed/core",
                  "bun:test"
            ]
      },
      {
            "name": "plugin-memory-summary",
            "path": "packages/plugin-memory-summary/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "@xandreed/core",
                  "bun:test"
            ]
      },
      {
            "name": "plugin-memory-digest",
            "path": "packages/plugin-memory-digest/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "@xandreed/core",
                  "bun:test"
            ]
      },
      {
            "name": "plugin-tool-discovery",
            "path": "packages/plugin-tool-discovery/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "@xandreed/core",
                  "bun:test"
            ]
      },
      {
            "name": "plugin-models-tests",
            "path": "packages/plugin-models/src/**/*.test.ts",
            "canImport": [
                  "plugin-models",
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "undici",
                  "ws",
                  "fast-check"
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
                  "effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "undici",
                  "ws"
            ]
      },
      {
            "name": "plugin-session-sqlite-tests",
            "path": "packages/plugin-session-sqlite/src/**/*.test*.ts",
            "canImport": [
                  "plugin-session-sqlite",
                  "core",
                  "plugin-sessions"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "ws",
                  "@xandreed/plugin-sessions"
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
                  "effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "ws"
            ]
      },
      {
            "name": "plugin-sessions",
            "path": "packages/plugin-sessions/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "@xandreed/core",
                  "bun:test"
            ]
      },
      {
            "name": "plugin-tasks-tests",
            "path": "packages/plugin-tasks/src/**/*.test.ts",
            "canImport": [
                  "plugin-tasks",
                  "core",
                  "plugin-sessions"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "@xandreed/core",
                  "@xandreed/plugin-sessions",
                  "bun:test"
            ]
      },
      {
            "name": "plugin-tasks",
            "path": "packages/plugin-tasks/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "@xandreed/core",
                  "bun:test"
            ]
      },
      // The one plugin test layer that imports upward (sdk, evals and the plugins
      // an agent needs): the skills directory and the workspace tools are tested
      // end to end, through Agent.define and a journey. Test files are not built
      // or packed, but if sdk ever lists plugin-workspace as a devDependency,
      // move those tests to sdk-tests rather than make the two devDependencies
      // a cycle.
      {
            "name": "plugin-workspace-tests",
            "path": "packages/plugin-workspace/src/**/*.test.ts",
            "canImport": [
                  "plugin-workspace",
                  "core",
                  "runtime",
                  "sdk",
                  "evals",
                  "plugin-agent-loop",
                  "plugin-memory-window",
                  "plugin-sessions",
                  "plugin-tool-discovery"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "node:",
                  "fast-check",
                  "@xandreed/core",
                  "@xandreed/runtime",
                  "@xandreed/sdk",
                  "@xandreed/evals",
                  "@xandreed/plugin-agent-loop",
                  "@xandreed/plugin-memory-window",
                  "@xandreed/plugin-sessions",
                  "@xandreed/plugin-tool-discovery",
                  "bun:test"
            ]
      },
      {
            "name": "plugin-workspace",
            "path": "packages/plugin-workspace/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "effect/ai",
                  "node:",
                  "@xandreed/core"
            ]
      },
      {
            "name": "plugin-telemetry-tests",
            "path": "packages/plugin-telemetry/src/**/*.test*.ts",
            "canImport": [
                  "plugin-telemetry",
                  "core",
                  "sdk",
                  "plugin-agent-loop",
                  "plugin-memory-window",
                  "plugin-tool-discovery",
                  "plugin-sessions"
            ],
            "externals": [
                  "effect",
                  "effect/",
                  "bun",
                  "bun:test",
                  "@xandreed/core",
                  "@xandreed/sdk",
                  "@xandreed/plugin-agent-loop",
                  "@xandreed/plugin-memory-window",
                  "@xandreed/plugin-tool-discovery",
                  "@xandreed/plugin-sessions"
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
                  "effect/",
                  "@xandreed/core",
                  "bun:test"
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
                  "effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core"
            ]
      },
      // The sdk tests may import the sdk by its package name and plugin-render: the
      // events guide's snippets (events-guide.test.ts) are copied into docs/events.md
      // as written, so they import only what a consumer can.
      {
            "name": "sdk-tests",
            "path": "packages/sdk/src/**/*.test.ts",
            "canImport": [
                  "sdk",
                  "core",
                  "runtime",
                  "plugin-session-sqlite",
                  "plugin-agent-loop",
                  "plugin-memory-window",
                  "plugin-memory-summary",
                  "plugin-memory-digest",
                  "plugin-tool-discovery",
                  "plugin-sessions",
                  "plugin-tasks",
                  "plugin-models",
                  "plugin-render"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "@xandreed/core",
                  "@xandreed/runtime",
                  "@xandreed/sdk",
                  "@xandreed/plugin-render",
                  "@xandreed/plugin-models",
                  "@xandreed/plugin-session-sqlite",
                  "@xandreed/plugin-sessions",
                  "@xandreed/plugin-tasks",
                  "@xandreed/plugin-agent-loop",
                  "@xandreed/plugin-memory-window",
                  "@xandreed/plugin-memory-summary",
                  "@xandreed/plugin-memory-digest",
                  "@xandreed/plugin-tool-discovery",
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
            "name": "plugin-render",
            "path": "packages/plugin-render/src/**",
            "canImport": [
                  "core"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "@xandreed/core",
                  "node:",
                  "bun:test"
            ]
      },
],
  },
}

export default config
