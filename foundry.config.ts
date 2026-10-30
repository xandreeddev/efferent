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
 * Boundaries: a cross-package import names the package (`@xandreed/core`),
 * and reaches the layer that holds the package's entry: dependency DIRECTION
 * is each layer's `canImport`, which names only the packages beneath it. The
 * subpath must be one the package's `exports` lists (a `-tests` layer may
 * also reach a `testing` module), and a relative import never leaves its
 * package. `externals` lists the third-party modules alone. `effect` admits
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
 * the loop's call assembly, the npm undici's fetch typed as the global one
 * (its requests and responses have the global fetch types' shape but are
 * distinct classes, so nothing downstream may rely on `instanceof Response` /
 * `Headers`). `as never` is the design there and nowhere else — a new one
 * anywhere else fails. A run's tool handlers are typed (`ToolHandlers`), so
 * the registry and the MCP bridge build them without one.
 * Test scaffolding (scripted providers, stubbed ports) is out of scope. An
 * entry whose file holds no `as never` any more fails too: the boundary
 * only shrinks.
 */
const ERASURE_BOUNDARY = [
  "packages/plugin-models/src/llm/router.ts",
  "packages/plugin-models/src/llm/compat.ts",
  "packages/plugin-models/src/llm/openAiCodex.ts",
  "packages/plugin-models/src/llm/providers.ts",
  "packages/plugin-models/src/transport/undici-fetch.adapter.ts",
  "packages/plugin-agent-loop/src/loop.ts",
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

/** A package's source, by its directory name: one entry of a list below. */
const src = (name: string): string => `packages/${name}/src/**`

/**
 * The package entries whose every export has a first-party consumer or a
 * `@public` tag (`quality/exports-have-consumers`): entry files, not
 * globs, one per line. An entry joins once its surface is curated: core's
 * five entries are.
 */
const CURATED_ENTRIES: ReadonlyArray<string> = [
  "packages/core/src/index.ts",
  "packages/core/src/conformance/index.ts",
  "packages/core/src/internal/index.ts",
  "packages/core/src/engine/index.ts",
  "packages/core/src/models/index.ts",
  "packages/runtime/src/index.ts",
  "packages/evals-langfuse/src/index.ts",
  "packages/evals-langsmith/src/index.ts",
  "packages/evals/src/index.ts",
  "packages/evals/src/stats.ts",
  "packages/evals-cli/src/index.ts",
]

/**
 * Open schemas (`effect/no-unknown-json`) core keeps for now. The MCP
 * bridge passes a model's arguments to a server it does not know; a
 * plugin entry's in-code options may hold values that are not JSON (a
 * function, a layer); the deprecated JSON helpers keep what they read
 * today until they are removed. Each entry goes once its file decodes what
 * it reads; the list only shrinks.
 */
const UNKNOWN_JSON_EDGES = [
  "packages/core/src/mcp/bridge.ts",
  "packages/core/src/harness/config.entity.ts",
  "packages/core/src/internal/json.entity.functions.ts",
]

/**
 * What `effect/branded-id-fields` judges: every package's entity files,
 * where its stored and published schemas live, and core's `src/spec`, whose
 * schemas live in older modules without that role.
 */
const ENTITY_FILES = [...CHECKED.map((glob) => `${glob}/*.entity.ts`), "packages/core/src/spec/**"]

/**
 * Casts to an object type (`effect/no-record-cast`) not yet replaced by a
 * decode or a type. The tool registry hands its two skill tools the
 * parameters the toolkit decoded, through a handler map typed `unknown`.
 * Each entry goes once its file is typed; like NULLABLE_EDGES the list
 * only shrinks.
 */
const RECORD_CAST_EDGES = [
  // Core's failure classifier reads a foreign failure's fields off an open record, until it decodes them.
  "packages/core/src/domain/agent-failure.entity.functions.ts",
  "packages/plugin-tool-discovery/src/registry.adapter.ts",
]

/**
 * The provider-neutral packages (`effect/no-provider-namespace`): core and
 * the agent loop carry a provider's metadata and options opaque, and write
 * their own under core's `ENGINE_KEY`. Their tests and kits drive the loop
 * with provider-shaped metadata and are left out. `responseModelOrLegacyOf`
 * (the agent loop's, through `@xandreed/core/internal`, and the deprecated
 * `extractModel`) still reads the stamp the models plugin's router kept
 * under `router`, for one minor release; its entry goes with it, and the
 * list only shrinks.
 */
const PROVIDER_NEUTRAL = [src("core"), src("plugin-agent-loop")]
const PROVIDER_NAMESPACE_EDGES = ["packages/core/src/domain/engine-stamp.entity.functions.ts"]

/**
 * Effect, Stream and Layer types whose requirements are `unknown`
 * (`effect/no-unknown-requirements`), so a service they read compiles
 * whether anything provides it or not. Tools and prompt sections declare
 * the services they read (`defineTool`, `definePromptSection`), checked by
 * key where they run. What stays: a turn's host layer (`NewTurn.layer`) and
 * the sdk code that provides it and the turn's plugins: a JSON config picks
 * those services at run time, and the plugin graph checks them by key.
 * FROZEN like NULLABLE_EDGES: the list only shrinks.
 */
const UNKNOWN_REQUIREMENT_EDGES = [
  "packages/core/src/ports/turn.port.ts",
  "packages/sdk/src/agent.adapter.ts",
]

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
  "packages/core/src/loop/modelPolicy.ts",
  "packages/core/src/loop/promptProvenance.ts",
  "packages/core/src/loop/stepContext.ts",
  "packages/core/src/loop/traceContent.ts",
  "packages/core/src/mcp/bridge.ts",
  "packages/core/src/memory/memory-session.ts",
  "packages/core/src/session/chassis.ts",
  "packages/core/src/spec/SpecDoc.ts",
  "packages/core/src/spec/codec.ts",
  "packages/core/src/spec/frontmatter.ts",
  "packages/core/src/turn/model-text.ts",
  "packages/core/src/turn/prompt-sections.ts",
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
    { rule: "effect/match-over-tag-switch", include: CHECKED },
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
    { rule: "effect/bounded-pubsub", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/no-process-env", include: CHECKED, exclude: [...ENVIRONMENT_EDGES, ...TEST_SCAFFOLDING] },
    { rule: "effect/no-ambient-time-random", include: CHECKED, exclude: ["**/*.adapter.ts", ...TEST_SCAFFOLDING] },
    { rule: "effect/no-locale-compare", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/require-sort-comparator", include: CHECKED, exclude: TEST_SCAFFOLDING },
    // Tests too: one that checks an error by its class passes where a second copy of core fails.
    { rule: "effect/no-instanceof-tagged-error", include: CHECKED },
    // A failure is kept and logged, not dropped; absence stays an Option.
    { rule: "effect/no-silent-ignore", include: CHECKED, exclude: TEST_SCAFFOLDING },
    {
      rule: "effect/no-option-unwrap",
      include: CHECKED,
      exclude: ["**/*.adapter.ts", "**/*.conformance.ts", ...TEST_SCAFFOLDING],
      allow: NULLABLE_EDGES,
    },
    { rule: "effect/no-stringified-cause", include: CHECKED, exclude: TEST_SCAFFOLDING },
    // Each with its allow list above, which only shrinks.
    { rule: "effect/no-unknown-json", include: CHECKED, exclude: TEST_SCAFFOLDING, allow: UNKNOWN_JSON_EDGES },
    { rule: "effect/no-record-cast", include: CHECKED, exclude: TEST_SCAFFOLDING, allow: RECORD_CAST_EDGES },
    // Provider metadata and options stay opaque where no provider is meant.
    {
      rule: "effect/no-provider-namespace",
      include: PROVIDER_NEUTRAL,
      exclude: ["**/*.conformance.ts", ...TEST_SCAFFOLDING],
      allow: PROVIDER_NAMESPACE_EDGES,
    },
    // A kit asserts the codes its port publishes.
    { rule: "effect/no-error-code-compare", include: CHECKED, exclude: ["**/*.conformance.ts", ...TEST_SCAFFOLDING] },
    { rule: "effect/prefer-effect-fn", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/require-concurrency-option", include: CHECKED, exclude: TEST_SCAFFOLDING },
    // What an effect requires is in its type (the list above aside).
    { rule: "effect/no-unknown-requirements", include: CHECKED, exclude: TEST_SCAFFOLDING, allow: UNKNOWN_REQUIREMENT_EDGES },
    { rule: "quality/no-skipped-tests", include: CHECKED },
    { rule: "quality/no-empty-catch", include: CHECKED },
    // One entry at a time (the list above).
    { rule: "quality/exports-have-consumers", include: CURATED_ENTRIES },
    { rule: "architecture/no-raw-promise-core", include: CHECKED },
    { rule: "architecture/no-runtime-imports-core", include: CHECKED },
    { rule: "architecture/contracts-contain-no-behavior", include: CHECKED },
    { rule: "architecture/context-tags-live-in-ports", include: CHECKED },
    { rule: "architecture/layers-live-at-edges", include: CHECKED },
    { rule: "architecture/role-suffix-required", include: CHECKED, exclude: ["packages/foundry/**"], allow: ROLELESS_FILES },
    { rule: "effect/branded-id-fields", include: ENTITY_FILES },
  ],
  checks: [],
  boundaries: {
    layers: [
      // The CLI's and the exporters' tests use the evals fixture, a testing module evals does not export.
      { name: "evals-cli-tests", path: "packages/evals-cli/src/**/*.test.ts", canImport: ["evals-cli", "evals"], externals: ["effect", "node:", "tsx/esm/api", "bun:test"] },
      { name: "evals-cli", path: "packages/evals-cli/src/**", canImport: ["evals"], externals: ["effect", "node:", "tsx/esm/api", "bun:test"] },
      { name: "evals-langfuse-tests", path: "packages/evals-langfuse/src/**/*.test.ts", canImport: ["evals-langfuse", "evals"], externals: ["effect", "@langfuse/client", "node:", "bun:test"] },
      { name: "evals-langfuse", path: "packages/evals-langfuse/src/**", canImport: ["evals"], externals: ["effect", "@langfuse/client", "node:", "bun:test"] },
      { name: "evals-langsmith-tests", path: "packages/evals-langsmith/src/**/*.test.ts", canImport: ["evals-langsmith", "evals"], externals: ["effect", "langsmith", "node:", "bun:test"] },
      { name: "evals-langsmith", path: "packages/evals-langsmith/src/**", canImport: ["evals"], externals: ["effect", "langsmith", "node:", "bun:test"] },
      {name:"evals",path:"packages/evals/src/**",canImport:[],externals:["effect","effect/ai","@noble/hashes/","node:","bun:test"]},
      // Core's layers, by a file's role rather than its folder; a glob takes no
      // alternatives, so a layer may need several entries. From the bottom:
      // the model (entities, and the References in `loop/`) imports nothing of
      // core; the ports, the model; the logic (entity functions, `internal/`,
      // the model-text frames), both; `core` (adapters, harness, the memory
      // session, prompt sections), those three; the turn engine (`engine/`),
      // those four; the kits, the engine too, since two of them run turns over
      // it. The entries (`index.ts`, `conformance/`, `internal/`, `engine/`
      // and `models/index.ts`) are `core` too, what `@xandreed/core` reaches,
      // and re-export every layer. `./conformance` is open to every package;
      // `./internal` only to the agent loop, the models plugin and the sdk,
      // `./engine` to the sdk and `./models` to the models plugin, each
      // granted as `core/<subpath>` in its importer's `canImport`.
      { name: "core-tests", path: "packages/core/src/**/*.test.ts", canImport: ["core-model", "core-ports", "core-logic", "core", "core-engine", "core-kits"], externals: ["effect", "effect/ai", "fast-check", "bun:test"] },
      { name: "core", path: "packages/core/src/**/index.ts", canImport: ["core-model", "core-ports", "core-logic", "core-engine", "core-kits"], externals: ["effect", "effect/ai"], restricted: ["internal", "engine", "models"] },
      { name: "core-model", path: "packages/core/src/**/*.entity.ts", canImport: [], externals: ["effect", "effect/ai"] },
      { name: "core-model", path: "packages/core/src/loop/*.ts", canImport: [], externals: ["effect", "effect/ai"] },
      { name: "core-ports", path: "packages/core/src/ports/**", canImport: ["core-model"], externals: ["effect", "effect/ai"] },
      { name: "core-logic", path: "packages/core/src/**/*.entity.functions.ts", canImport: ["core-model", "core-ports"], externals: ["effect", "effect/ai"] },
      { name: "core-logic", path: "packages/core/src/internal/**", canImport: ["core-model", "core-ports"], externals: ["effect", "effect/ai"] },
      { name: "core-logic", path: "packages/core/src/turn/model-text.ts", canImport: ["core-model", "core-ports"], externals: ["effect", "effect/ai"] },
      { name: "core-engine", path: "packages/core/src/engine/**", canImport: ["core-model", "core-ports", "core-logic", "core"], externals: ["effect", "effect/ai"] },
      { name: "core-kits", path: "packages/core/src/**/*.conformance.ts", canImport: ["core-model", "core-ports", "core-logic", "core", "core-engine"], externals: ["effect", "effect/ai"] },
      { name: "core", path: "packages/core/src/**", canImport: ["core-model", "core-ports", "core-logic"], externals: ["effect", "effect/ai"] },
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
      // The step loop's tests build a turn's bus and tasks from the engine (`makeTurnEvents`, `makeTurnTasks`).
      {
            "name": "plugin-agent-loop-tests",
            "path": "packages/plugin-agent-loop/src/**/*.test.ts",
            "canImport": [
                  "plugin-agent-loop",
                  "core",
                  "core/internal",
                  "core/engine"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "node:",
                  "bun",
                  "bun:",
            ]
      },
      {
            "name": "plugin-agent-loop",
            "path": "packages/plugin-agent-loop/src/**",
            "canImport": [
                  "core",
                  "core/internal"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "node:",
                  "bun",
                  "bun:",
            ]
      },
      // The tests read a tool's parameters as the model sees them (`toolParametersSchema`).
      {
            "name": "plugin-memory-window-tests",
            "path": "packages/plugin-memory-window/src/**/*.test.ts",
            "canImport": [
                  "plugin-memory-window",
                  "core",
                  "core/internal"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "bun:test"
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
                  "bun:test"
            ]
      },
      // The registry's tests open its tools in a turn built over the engine (`TurnLive`).
      {
            "name": "plugin-tool-discovery-tests",
            "path": "packages/plugin-tool-discovery/src/**/*.test.ts",
            "canImport": [
                  "plugin-tool-discovery",
                  "core",
                  "core/engine"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
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
                  "bun:test"
            ]
      },
      {
            "name": "plugin-models-tests",
            "path": "packages/plugin-models/src/**/*.test.ts",
            "canImport": [
                  "plugin-models",
                  "core",
                  "core/internal",
                  "core/models"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "node:",
                  "bun",
                  "bun:",
                  "undici",
                  "ws",
                  "fast-check"
            ]
      },
      {
            "name": "plugin-models",
            "path": "packages/plugin-models/src/**",
            "canImport": [
                  "core",
                  "core/internal",
                  "core/models"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "node:",
                  "bun",
                  "bun:",
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
                  "ws",
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
                  "ws"
            ]
      },
      // The tests trace a begin as `Agent.turn` does, with the engine's `traceTurnBegin`.
      {
            "name": "plugin-sessions-tests",
            "path": "packages/plugin-sessions/src/**/*.test.ts",
            "canImport": [
                  "plugin-sessions",
                  "core",
                  "core/engine"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "bun:test"
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
                  "plugin-tool-discovery",
                  "core/internal"
            ],
            "externals": [
                  "effect",
                  "@effect/",
                  "effect/",
                  "node:",
                  "fast-check",
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
                  "plugin-sessions",
                  "core/engine"
            ],
            "externals": [
                  "effect",
                  "effect/",
                  "bun",
                  "bun:test",
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
                  "core/internal",
                  "core/engine",
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
            ]
      },
      {
            "name": "sdk",
            "path": "packages/sdk/src/**",
            "canImport": [
                  "core",
                  "core/internal",
                  "core/engine",
                  "runtime"
            ],
            "externals": [
                  "effect",
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
                  "node:",
                  "bun:test"
            ]
      },
],
  },
}

export default config
