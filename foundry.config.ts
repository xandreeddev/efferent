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
/**
 * Test code as the build leaves it out (scripts/build-check.ts): test and
 * bench files, `testing` modules and `testing/` folders. It is never built
 * or published, so the rules that guard what crosses a boundary (casts, the
 * environment, time, randomness, decoding) do not apply to it.
 */
const TEST_SCAFFOLDING = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.bench.ts",
  "**/testing.ts",
  "**/*.testing.ts",
  "**/testing.port.ts",
  "**/testing/**",
]

/**
 * The process edges that read `process.env` themselves: an entry point's
 * `main.ts`, and the local bash adapter, which hands each command a
 * filtered copy of the host's whole environment (a map `Config` cannot
 * enumerate). Everything else reads a variable through `Config`, so a
 * ConfigProvider can supply it.
 */
const ENVIRONMENT_EDGES = ["**/main.ts", "packages/plugin-workspace/src/bash.adapter.ts"]

/** A package's source, by its directory name: one entry of the lists below. */
const src = (name: string): string => `packages/${name}/src/**`

/**
 * Rules that enter one package at a time, never through the baseline. Each
 * list names the packages already clean of its rule, one per line: a
 * cleanup change fixes one package's findings and adds its line. Once a
 * list names every package in CHECKED, its rule takes CHECKED instead.
 */
const STRINGIFIED_CAUSE_CLEAN = [
  "sdk",
  "plugin-memory-window",
  "plugin-memory-summary",
  "plugin-memory-digest",
  "plugin-tool-discovery",
  "plugin-sessions",
  "plugin-tasks",
  "plugin-render",
  "plugin-workspace",
  "plugin-telemetry",
].map(src)

const ERROR_CODE_COMPARE_CLEAN = [
  "core",
  "evals-cli",
  "evals-langfuse",
  "evals-langsmith",
  "plugin-agent-loop",
  "runtime",
  "plugin-memory-window",
  "plugin-memory-summary",
  "plugin-memory-digest",
  "plugin-tool-discovery",
  "plugin-models",
  "plugin-workspace",
  "plugin-telemetry",
  "foundry",
].map(src)

const EFFECT_FN_CLEAN = [
  "sdk",
  "plugin-memory-window",
  "plugin-memory-digest",
].map(src)

const CONCURRENCY_STATED = [
  "evals-langfuse",
  "evals-langsmith",
  "sdk",
  "plugin-memory-summary",
  "plugin-memory-digest",
  "plugin-tool-discovery",
].map(src)

/**
 * `effect/match-over-tag-switch` runs everywhere on a `switch` or else-if
 * ladder over `_tag`; in the packages listed it also refuses ternary
 * chains and the `type`, `role` and `mode` discriminants. Everywhere else
 * is the rule's `boundary`, where those later matches are tolerated.
 */
const MATCH_CHAINS_CLEAN = [
  "evals",
  "evals-cli",
  "evals-langfuse",
  "evals-langsmith",
  "plugin-agent-loop",
  "runtime",
  "plugin-memory-window",
  "plugin-memory-summary",
  "plugin-memory-digest",
  "plugin-tool-discovery",
  "plugin-models",
  "plugin-session-sqlite",
  "plugin-sessions",
  "plugin-tasks",
  "plugin-render",
  "plugin-workspace",
  "plugin-telemetry",
  "foundry",
].map(src)

/**
 * The files that had no role suffix when `architecture/role-suffix-required`
 * arrived. FROZEN: the list only shrinks. The gate fails on an entry that
 * names a file that is gone or now has a role, so a rename, a split into an
 * entity and functions pair or a deletion removes its entry in the same
 * change; a new file takes a role instead of joining. Foundry is out of
 * the rule: development tooling laid out by folder, whose own profile
 * (`packages/foundry/foundry.config.ts`) enforces those layers.
 */
const ROLELESS_FILES = [
  "packages/core/src/conformance.functions.ts",
  "packages/core/src/loop/cacheKey.ts",
  "packages/core/src/loop/mapping.ts",
  "packages/core/src/loop/modelPolicy.ts",
  "packages/core/src/loop/promptProvenance.ts",
  "packages/core/src/loop/stepContext.ts",
  "packages/core/src/loop/streamFold.ts",
  "packages/core/src/loop/toolSchema.ts",
  "packages/core/src/loop/traceContent.ts",
  "packages/core/src/mcp/bridge.ts",
  "packages/core/src/memory/memory-session.ts",
  "packages/core/src/session/chassis.ts",
  "packages/core/src/spec/SpecDoc.ts",
  "packages/core/src/spec/codec.ts",
  "packages/core/src/spec/frontmatter.ts",
  "packages/core/src/turn/model-text.ts",
  "packages/core/src/turn/prompt-sections.ts",
  "packages/core/src/turn/turn-bus.ts",
  "packages/core/src/turn/turn-lifecycle.ts",
  "packages/core/src/turn/turn-run.ts",
  "packages/core/src/util/glob.ts",
  "packages/core/src/util/json.ts",
  "packages/core/src/util/random-id.ts",
  "packages/evals/src/cli.functions.ts",
  "packages/evals/src/contracts/evaluation-app.contract.functions.ts",
  "packages/evals/src/contracts/evaluation-app.contract.ts",
  "packages/evals/src/evaluators/llm.ts",
  "packages/evals/src/evaluators/pairwise.ts",
  "packages/evals/src/evaluators/semantic.ts",
  "packages/evals/src/graders/retrieval/contextual-precision.functions.ts",
  "packages/evals/src/graders/retrieval/contextual-recall.functions.ts",
  "packages/evals/src/graders/retrieval/contextual-relevancy.functions.ts",
  "packages/evals/src/graders/retrieval/ranking.functions.ts",
  "packages/evals/src/stats.ts",
  "packages/plugin-agent-loop/src/loop.ts",
  "packages/plugin-models/src/auth/anthropicOAuth.ts",
  "packages/plugin-models/src/auth/localAuth.ts",
  "packages/plugin-models/src/auth/openAiCodexOAuth.ts",
  "packages/plugin-models/src/llm/compat.ts",
  "packages/plugin-models/src/llm/modelCatalog.ts",
  "packages/plugin-models/src/llm/openAiCodex.ts",
  "packages/plugin-models/src/llm/openAiCodexWebSocket.ts",
  "packages/plugin-models/src/llm/providers.ts",
  "packages/plugin-models/src/llm/retry.ts",
  "packages/plugin-models/src/llm/router.ts",
  "packages/plugin-models/src/llm/sse.ts",
  "packages/plugin-models/src/llm/utilityLlm.ts",
  "packages/plugin-models/src/settings/localSettings.ts",
  "packages/plugin-models/src/settings/roleView.ts",
  "packages/plugin-models/src/storage/json-file.ts",
  "packages/plugin-render/src/output.ts",
  "packages/plugin-render/src/render-output.tools.ts",
  "packages/plugin-telemetry/src/telemetry-metrics.ts",
  "packages/runtime/src/graph.ts",
]

/**
 * Adapters by role whose names predate the role suffixes, each unwrapping
 * an `Option` where the edge takes a nullable (`effect/no-option-unwrap`):
 * the router hands a selection's credential and key to `buildProvider`
 * (public; `undefined` for none), and the subscription's WebSocket
 * transport answers with OpenAI's error body (`null` fields). Like
 * ROLELESS_FILES the list only shrinks: an entry renamed `*.adapter.ts`,
 * or that no longer unwraps, fails until it is removed.
 */
const NULLABLE_EDGES = [
  "packages/plugin-models/src/llm/router.ts",
  "packages/plugin-models/src/llm/openAiCodexWebSocket.ts",
]

/**
 * No file git tracks may name a person's home directory, or a term from
 * the local denylist (`quality/no-private-text`). Tests and fixtures that
 * need a home write one of the placeholder names below, never a real one;
 * no file is exempt. The denylist is optional and never committed: one
 * term per line (blank lines and `#` lines skipped), matched
 * case-insensitively as a whole word; without the file only paths are
 * checked, and the gate fails if git would not ignore it.
 */
const privateText: NonNullable<typeof GateSuiteConfig.Encoded["privateText"]> = {
  include: ["**"],
  exclude: ["**/*.png"],
  placeholders: ["user", "username", "me", "you", "someone", "example", "runner", "Shared"],
  denylist: ".foundry/private-terms.txt",
}

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
  privateText,
  rules: [
    { rule: "effect/no-try-catch", include: CHECKED },
    { rule: "effect/no-let", include: CHECKED },
    { rule: "effect/no-loop-statements", include: CHECKED },
    { rule: "effect/no-nullable-return", include: CHECKED },
    {
      rule: "effect/match-over-tag-switch",
      include: CHECKED,
      boundary: CHECKED.filter((glob) => !MATCH_CHAINS_CLEAN.includes(glob)),
    },
    { rule: "effect/no-as-any", include: CHECKED },
    {
      rule: "effect/no-as-never",
      include: CHECKED,
      exclude: TEST_SCAFFOLDING,
      // `as never` is the design there; `as never as T` still fails.
      boundary: ERASURE_BOUNDARY,
    },
    { rule: "effect/no-parallel-interface", include: CHECKED },
    // What crosses a boundary is decoded, or comes from a service.
    { rule: "effect/no-json-parse", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/no-sync-codec", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/no-cause-pretty-data", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/no-effect-promise", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/no-promise-all", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/callback-buffer-size", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/no-process-env", include: CHECKED, exclude: [...ENVIRONMENT_EDGES, ...TEST_SCAFFOLDING] },
    { rule: "effect/no-ambient-time-random", include: CHECKED, exclude: ["**/*.adapter.ts", ...TEST_SCAFFOLDING] },
    { rule: "effect/no-locale-compare", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/require-sort-comparator", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/no-instanceof-tagged-error", include: CHECKED, exclude: TEST_SCAFFOLDING },
    // A failure is kept and logged, not dropped; absence stays an Option.
    { rule: "effect/no-silent-ignore", include: CHECKED, exclude: TEST_SCAFFOLDING },
    {
      rule: "effect/no-option-unwrap",
      include: CHECKED,
      exclude: ["**/*.adapter.ts", "**/*.conformance.ts", ...TEST_SCAFFOLDING],
      allow: NULLABLE_EDGES,
    },
    // One package at a time (the lists above).
    { rule: "effect/no-stringified-cause", include: STRINGIFIED_CAUSE_CLEAN, exclude: TEST_SCAFFOLDING },
    // A kit asserts the codes its port publishes.
    { rule: "effect/no-error-code-compare", include: ERROR_CODE_COMPARE_CLEAN, exclude: ["**/*.conformance.ts", ...TEST_SCAFFOLDING] },
    { rule: "effect/prefer-effect-fn", include: EFFECT_FN_CLEAN, exclude: TEST_SCAFFOLDING },
    { rule: "effect/require-concurrency-option", include: CONCURRENCY_STATED, exclude: TEST_SCAFFOLDING },
    { rule: "quality/no-skipped-tests", include: CHECKED },
    { rule: "quality/no-empty-catch", include: CHECKED },
    { rule: "architecture/no-raw-promise-core", include: CHECKED },
    { rule: "architecture/no-runtime-imports-core", include: CHECKED },
    { rule: "architecture/contracts-contain-no-behavior", include: CHECKED },
    { rule: "architecture/context-tags-live-in-ports", include: CHECKED },
    { rule: "architecture/layers-live-at-edges", include: CHECKED },
    { rule: "architecture/role-suffix-required", include: CHECKED, exclude: ["packages/foundry/**"], allow: ROLELESS_FILES },
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
      // The plugin test layers that import upward, this one and
      // plugin-telemetry-tests below (sdk, the plugins an agent needs and, here,
      // evals): the skills directory, the workspace tools and the telemetry
      // plugin are tested end to end, through Agent.define. Test files are not
      // built or packed, but if sdk ever lists one of these plugins as a
      // devDependency, move its tests to sdk-tests rather than make the two
      // devDependencies a cycle.
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
