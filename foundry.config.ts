import { Array as Arr } from "effect"
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
 * package. `externals` lists the third-party modules alone, exactly those
 * the layer's files import (by an import clause or `import("…")`): one that
 * none imports fails, so a list only shrinks. `effect` admits Effect's core
 * modules; each `effect/<module>` barrel (effect/ai was @effect/ai in v3;
 * effect/testing holds the test services) is named by itself, and no layer
 * takes the raw `effect/` or `@effect/` prefix. So a provider package
 * (`@effect/ai-anthropic`) is the sdk kernel's Anthropic provider's alone
 * (ADR 0026), Bun the kernel's SQLite journal's alone (`bun:sqlite`, imported
 * only when it is built on Bun), and the test libraries (`bun:test`,
 * `fast-check`, `effect/testing`) the `-tests` layers' alone.
 */
const CHECKED = [
  "packages/core/src/**",
  "packages/evals/src/**",
  "packages/evals-cli/src/**",
  "packages/evals-langfuse/src/**",
  "packages/evals-langsmith/src/**",
  "packages/sdk/src/**",
  // The factory judges itself by the same profile (the dogfood).
  "packages/foundry/src/**",
]

/**
 * Test code as the build leaves it out (scripts/build-check.ts): test and
 * bench files, `testing` modules and `testing/` folders. It is never built
 * or published, so the rules that guard what crosses a boundary (casts, the
 * environment, time, randomness, decoding) do not apply to it.
 */
const TEST_SCAFFOLDING: Arr.NonEmptyReadonlyArray<string> = [
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
 * `main.ts`. Everything else reads a variable through `Config`, so a
 * ConfigProvider can supply it.
 */
const ENVIRONMENT_EDGES = ["**/main.ts"]

/** What the sdk kernel's test code may import: every layer of the kernel, and core's. */
const SDK_KERNEL_TESTS = [
  "sdk-kernel",
  "sdk-kernel-contracts",
  "sdk-kernel-plugin-inbox",
  "sdk-kernel-plugin-journal-in-process",
  "sdk-kernel-plugin-journal-web-storage",
  "sdk-kernel-plugin-model-scripted",
  "sdk-kernel-plugin-memory-flat",
  "sdk-kernel-plugin-memory-summary",
  "sdk-kernel-plugin-session",
  "sdk-kernel-plugin-tool-read-result",
  "sdk-kernel-plugin-approval-auto",
  "sdk-kernel-plugin-files-in-memory",
  "sdk-kernel-plugin-tool-files",
  "sdk-kernel-plugin-tasks",
  "sdk-kernel-plugin-skills",
  "sdk-kernel-plugin-facts",
  "sdk-kernel-plugin-embedder-recorded",
  "sdk-kernel-plugin-vectors-in-memory",
  "sdk-kernel-plugin-media-in-memory",
  "sdk-kernel-plugin-knowledge",
  "sdk-kernel-plugin-shell-scripted",
  "sdk-kernel-plugin-tool-shell",
  "sdk-kernel-plugin-search-files",
  "sdk-kernel-plugin-tool-search",
  "sdk-kernel-node",
  "sdk-kernel-node-writer",
  "sdk-kernel-node-journal-directory",
  "sdk-kernel-node-journal-sqlite",
  "sdk-kernel-node-model-spend",
  "sdk-kernel-node-model-openai-compatible",
  "sdk-kernel-node-model-anthropic",
  "sdk-kernel-node-embedder-openai-compatible",
  "sdk-kernel-node-media-directory",
  "sdk-kernel-node-shell-process",
  "sdk-kernel-node-files-disk",
  "sdk-kernel-node-telemetry-otlp",
  "core-kernel",
]

/** A package's source, by its directory name: one entry of a list below. */
const src = (name: string): string => `packages/${name}/src/**`

/**
 * A package's test layer, `<name>-tests`: its test code, one entry per
 * TEST_SCAFFOLDING glob (a glob takes no alternatives), placed before the
 * package's own layer, since the first match wins. The test libraries are
 * allowed here and in no source layer. It may import what the package's own
 * layer may, and the package; more only where its tests need it.
 */
const testLayer = (name: string, canImport: ReadonlyArray<string>, externals: ReadonlyArray<string>) =>
  Arr.map(TEST_SCAFFOLDING, (glob) => ({ name: `${name}-tests`, path: `packages/${name}/src/${glob}`, canImport: [...canImport], externals: [...externals] }))

/**
 * Every published entry, one file per line: each `exports` subpath of each
 * package the build publishes (`names` in scripts/build-packages.ts), whose
 * every export has a first-party consumer or a `@public` tag
 * (`quality/exports-have-consumers`). The rule fails on a listed file no
 * subpath points at, and the registration gate on a package whose root
 * entry is missing here; a subpath joins in the change that adds it to
 * `exports`. A hand list, not one derived from the manifests: the
 * registration gate reads its entries from the source.
 */
const CURATED_ENTRIES: ReadonlyArray<string> = [
  "packages/core/src/index.ts",
  "packages/evals-langfuse/src/index.ts",
  "packages/evals-langsmith/src/index.ts",
  "packages/evals/src/index.ts",
  "packages/evals/src/stats.ts",
  "packages/evals-cli/src/index.ts",
  "packages/sdk/src/index.ts",
  "packages/sdk/src/node/index.ts",
]

/**
 * What `effect/branded-id-fields` judges: every package's entity files,
 * where its stored and published schemas live.
 */
const ENTITY_FILES = CHECKED.map((glob) => `${glob}/*.entity.ts`)

/**
 * The provider-neutral package (`effect/no-provider-namespace`): core
 * carries a provider's metadata and options opaque, with no file excused.
 * Its tests and kits are left out.
 */
const PROVIDER_NEUTRAL = [src("core")]

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
  "packages/evals/src/cli.functions.ts",
  "packages/evals/src/contracts/evaluation-app.contract.functions.ts",
  "packages/evals/src/contracts/evaluation-app.contract.ts",
  "packages/evals/src/evaluators/semantic.ts",
  "packages/evals/src/graders/retrieval/contextual-precision.functions.ts",
  "packages/evals/src/graders/retrieval/contextual-recall.functions.ts",
  "packages/evals/src/graders/retrieval/contextual-relevancy.functions.ts",
  "packages/evals/src/graders/retrieval/ranking.functions.ts",
  "packages/evals/src/stats.ts",
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
 * base tsconfig's `paths` and its root entry in CURATED_ENTRIES. The
 * registration gate fails on every package one of them misses, naming the
 * list. The docs site is not a TypeScript package of the framework, and
 * foundry is development tooling: never built or published.
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
    {
      source: "const",
      file: "foundry.config.ts",
      name: "CURATED_ENTRIES",
      entry: "{path}/src/index.ts",
      exclude: ["packages/foundry"],
      hint: 'add "{path}/src/index.ts", and each subpath entry of its package.json `exports`, to CURATED_ENTRIES in foundry.config.ts: each export is then imported by another package, a script or a doc code block, or tagged @public',
    },
    { source: "json-keys", file: "tsconfig.base.json", keys: ["compilerOptions", "paths"], entry: "{name}" },
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
    { rule: "effect/no-nullable-return", include: CHECKED },
    { rule: "effect/match-over-tag-switch", include: CHECKED },
    { rule: "effect/no-as-any", include: CHECKED },
    { rule: "effect/no-as-never", include: CHECKED, exclude: TEST_SCAFFOLDING },
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
    { rule: "effect/no-ambient-time-random", include: CHECKED, exclude: TEST_SCAFFOLDING },
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
    },
    { rule: "effect/no-stringified-cause", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/no-unknown-json", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/no-record-cast", include: CHECKED, exclude: TEST_SCAFFOLDING },
    // Provider metadata and options stay opaque where no provider is meant.
    {
      rule: "effect/no-provider-namespace",
      include: PROVIDER_NEUTRAL,
      exclude: ["**/*.conformance.ts", ...TEST_SCAFFOLDING],
    },
    // A kit asserts the codes its port publishes.
    { rule: "effect/no-error-code-compare", include: CHECKED, exclude: ["**/*.conformance.ts", ...TEST_SCAFFOLDING] },
    // A foreign code is read by `errorCodeOf`.
    { rule: "effect/no-code-property-guard", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/prefer-effect-fn", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "effect/require-concurrency-option", include: CHECKED, exclude: TEST_SCAFFOLDING },
    // What an effect requires is in its type.
    { rule: "effect/no-unknown-requirements", include: CHECKED, exclude: TEST_SCAFFOLDING },
    { rule: "quality/no-skipped-tests", include: CHECKED },
    { rule: "quality/no-empty-catch", include: CHECKED },
    // Every published entry (the list above).
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
      ...testLayer("evals-cli", ["evals-cli", "evals", "core-kernel"], ["effect", "node:", "bun:test", "fast-check"]),
      { name: "evals-cli", path: src("evals-cli"), canImport: ["evals"], externals: ["effect", "node:", "tsx/esm/api"] },
      ...testLayer("evals-langfuse", ["evals-langfuse", "evals"], ["effect", "effect/testing", "bun:test"]),
      { name: "evals-langfuse", path: src("evals-langfuse"), canImport: ["evals"], externals: ["effect", "@langfuse/client", "node:"] },
      ...testLayer("evals-langsmith", ["evals-langsmith", "evals"], ["effect", "effect/testing", "bun:test"]),
      { name: "evals-langsmith", path: src("evals-langsmith"), canImport: ["evals"], externals: ["effect", "langsmith", "node:"] },
      // evals reaches core only for the ModelSpend ledger its runs share across their trials.
      // The eval tests also reach the kernel's Node entry (`@xandreed/sdk/node`, a devDependency, a restricted
      // subpath of `sdk-kernel`, the layer of the sdk's root entry): one runs a run's budget over a real model provider
      // of the kernel's (ADR 0026). The package's own code never imports the sdk.
      ...testLayer("evals", ["evals", "core-kernel", "sdk-kernel/node"], ["effect", "effect/ai", "effect/http", "node:", "bun:test"]),
      { name: "evals", path: src("evals"), canImport: ["core-kernel"], externals: ["effect", "effect/ai", "@noble/hashes/"] },
      // Core's kernel (`packages/core/src`, the package's root entry): one layer for all its roles, which imports
      // no runtime module. A package that imports `@xandreed/core` names `core-kernel`; the layer keeps its name.
      { name: "core-kernel-tests", path: "packages/core/src/**/*.test.ts", canImport: ["core-kernel"], externals: ["effect", "bun:test"] },
      { name: "core-kernel", path: "packages/core/src/**", canImport: [], externals: ["effect"] },
      ...testLayer("foundry", ["foundry"], ["effect", "effect/testing", "typescript", "node:", "bun:test"]),
      { name: "foundry", path: src("foundry"), canImport: [], externals: ["effect", "typescript", "node:"] },
      // The sdk's kernel (`packages/sdk/src`, the package's root entry; its
      // Node entry `./node`, a restricted subpath of `sdk-kernel`, so the
      // browser entry cannot reach it by the package's name). The layers keep
      // their `sdk-kernel-*` names. It imports core's kernel and nothing else of the workspace.
      // Inside it the import graph is
      // the one ADR 0002 records: the contracts (`contracts/**`) import core's
      // kernel and one another, never a plugin; each plugin folder is a layer
      // of its own that imports the contracts and core's kernel, never another
      // plugin's folder; the entry (`index.ts`) and the test code reach them
      // all. The test code is every TEST_SCAFFOLDING glob under the kernel,
      // placed first, so test code inside a contract or a plugin folder is
      // not that folder's source. A new plugin folder gets its layer here,
      // before `sdk-kernel`, and its name in `sdk-kernel`'s `canImport` and
      // in `SDK_KERNEL_TESTS`.
      ...Arr.map(TEST_SCAFFOLDING, (glob) => ({
        name: "sdk-kernel-tests",
        path: `packages/sdk/src/${glob}`,
        canImport: [...SDK_KERNEL_TESTS],
        externals: ["effect", "effect/ai", "effect/http", "node:", "bun:sqlite", "bun:test"],
      })),
      // The kernel's Node entry (`packages/sdk/src/node`, `./node`, ADR 0024): the ports that need a
      // runtime's modules, which Node 24 and Bun both provide. One layer per folder: the one-writer lock
      // (`writer/`), shared by the stores, and each port's folder, which imports core's kernel, the contracts and
      // the lock, never another port's folder; then the entry, which reaches them all. None is in `sdk-kernel`'s
      // `canImport`, so the browser entry cannot import one. `bun:sqlite` is imported only when the SQLite journal
      // is built on Bun (`node:sqlite` on Node), so the entry loads on both. A new port's folder gets its layer
      // here, its name in the entry's `canImport` and in `SDK_KERNEL_TESTS`.
      { name: "sdk-kernel-node-writer", path: "packages/sdk/src/node/writer/**", canImport: ["core-kernel"], externals: ["effect", "node:"] },
      { name: "sdk-kernel-node-journal-directory", path: "packages/sdk/src/node/journal-directory/**", canImport: ["sdk-kernel-node-writer", "core-kernel"], externals: ["effect", "node:"] },
      { name: "sdk-kernel-node-journal-sqlite", path: "packages/sdk/src/node/journal-sqlite/**", canImport: ["sdk-kernel-node-writer", "core-kernel"], externals: ["effect", "node:", "bun:sqlite"] },
      // The model providers (ADR 0026): the spend charge both share (`model-spend/`, as the stores share the lock), and
      // a folder per provider. The Anthropic one is the only layer that names a provider
      // package (`@effect/ai-anthropic`); the OpenAI-compatible one speaks its wire itself.
      { name: "sdk-kernel-node-model-spend", path: "packages/sdk/src/node/model-spend/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect", "effect/ai", "effect/http"] },
      { name: "sdk-kernel-node-model-openai-compatible", path: "packages/sdk/src/node/model-openai-compatible/**", canImport: ["sdk-kernel-node-model-spend", "core-kernel"], externals: ["effect", "effect/ai", "effect/http"] },
      { name: "sdk-kernel-node-model-anthropic", path: "packages/sdk/src/node/model-anthropic/**", canImport: ["sdk-kernel-node-model-spend", "core-kernel"], externals: ["effect", "effect/ai", "effect/http", "@effect/ai-anthropic"] },
      // An embedder over the OpenAI-compatible `/embeddings` wire (ADR 0032): the contract it implements, and the charge the
      // model providers share, since its requests charge the ledger as theirs do.
      { name: "sdk-kernel-node-embedder-openai-compatible", path: "packages/sdk/src/node/embedder-openai-compatible/**", canImport: ["sdk-kernel-node-model-spend", "sdk-kernel-contracts", "core-kernel"], externals: ["effect", "effect/ai", "effect/http"] },
      // The workspace's ports (ADR 0028): a shell over `node:child_process`, and files in a folder of the disk. Each imports the contract it implements
      // from `sdk-kernel-contracts` and nothing of another port's folder; it holds no store, so it takes no lock.
      { name: "sdk-kernel-node-shell-process", path: "packages/sdk/src/node/shell-process/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect", "node:"] },
      // A media store in a folder (ADR 0034): the contract it implements, nothing of another port's folder, and no lock,
      // since a blob never changes once kept.
      { name: "sdk-kernel-node-media-directory", path: "packages/sdk/src/node/media-directory/**", canImport: ["sdk-kernel-contracts"], externals: ["effect", "node:"] },
      { name: "sdk-kernel-node-files-disk", path: "packages/sdk/src/node/files-disk/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect", "node:"] },
      // The export of a host's traces and metrics over OTLP/HTTP (ADR 0030): Effect's own exporters behind a span policy,
      // a layer around the host's program. It imports nothing of the kernel: the spans and metrics it sends are the
      // program's, whoever made them.
      { name: "sdk-kernel-node-telemetry-otlp", path: "packages/sdk/src/node/telemetry-otlp/**", canImport: [], externals: ["effect", "effect/ai", "effect/http", "effect/observability"] },
      { name: "sdk-kernel-node", path: "packages/sdk/src/node/**", canImport: ["sdk-kernel-node-writer", "sdk-kernel-node-journal-directory", "sdk-kernel-node-journal-sqlite", "sdk-kernel-node-model-spend", "sdk-kernel-node-model-openai-compatible", "sdk-kernel-node-model-anthropic", "sdk-kernel-node-embedder-openai-compatible", "sdk-kernel-node-media-directory", "sdk-kernel-node-shell-process", "sdk-kernel-node-files-disk", "sdk-kernel-node-telemetry-otlp"], externals: [] },
      { name: "sdk-kernel-contracts", path: "packages/sdk/src/contracts/**", canImport: ["core-kernel"], externals: ["effect", "effect/ai"] },
      { name: "sdk-kernel-plugin-inbox", path: "packages/sdk/src/plugins/inbox/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-journal-in-process", path: "packages/sdk/src/plugins/journal-in-process/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-journal-web-storage", path: "packages/sdk/src/plugins/journal-web-storage/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-model-scripted", path: "packages/sdk/src/plugins/model-scripted/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect", "effect/ai"] },
      { name: "sdk-kernel-plugin-memory-flat", path: "packages/sdk/src/plugins/memory-flat/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-memory-summary", path: "packages/sdk/src/plugins/memory-summary/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-session", path: "packages/sdk/src/plugins/session/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-approval-auto", path: "packages/sdk/src/plugins/approval-auto/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-facts", path: "packages/sdk/src/plugins/facts/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect", "effect/ai"] },
      { name: "sdk-kernel-plugin-skills", path: "packages/sdk/src/plugins/skills/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect", "effect/ai"] },
      { name: "sdk-kernel-plugin-tool-read-result", path: "packages/sdk/src/plugins/tool-read-result/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect", "effect/ai"] },
      { name: "sdk-kernel-plugin-files-in-memory", path: "packages/sdk/src/plugins/files-in-memory/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-tool-files", path: "packages/sdk/src/plugins/tool-files/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect", "effect/ai"] },
      { name: "sdk-kernel-plugin-tasks", path: "packages/sdk/src/plugins/tasks/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect", "effect/ai"] },
      { name: "sdk-kernel-plugin-embedder-recorded", path: "packages/sdk/src/plugins/embedder-recorded/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-vectors-in-memory", path: "packages/sdk/src/plugins/vectors-in-memory/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-media-in-memory", path: "packages/sdk/src/plugins/media-in-memory/**", canImport: ["sdk-kernel-contracts"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-knowledge", path: "packages/sdk/src/plugins/knowledge/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-shell-scripted", path: "packages/sdk/src/plugins/shell-scripted/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-tool-shell", path: "packages/sdk/src/plugins/tool-shell/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect", "effect/ai"] },
      { name: "sdk-kernel-plugin-search-files", path: "packages/sdk/src/plugins/search-files/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect"] },
      { name: "sdk-kernel-plugin-tool-search", path: "packages/sdk/src/plugins/tool-search/**", canImport: ["sdk-kernel-contracts", "core-kernel"], externals: ["effect", "effect/ai"] },
      { name: "sdk-kernel", path: "packages/sdk/src/**", canImport: ["sdk-kernel-contracts", "sdk-kernel-plugin-inbox", "sdk-kernel-plugin-journal-in-process", "sdk-kernel-plugin-journal-web-storage", "sdk-kernel-plugin-memory-flat", "sdk-kernel-plugin-memory-summary", "sdk-kernel-plugin-model-scripted", "sdk-kernel-plugin-session", "sdk-kernel-plugin-tool-read-result", "sdk-kernel-plugin-approval-auto", "sdk-kernel-plugin-skills", "sdk-kernel-plugin-facts", "sdk-kernel-plugin-files-in-memory", "sdk-kernel-plugin-tool-files", "sdk-kernel-plugin-tasks", "sdk-kernel-plugin-embedder-recorded", "sdk-kernel-plugin-vectors-in-memory", "sdk-kernel-plugin-media-in-memory", "sdk-kernel-plugin-knowledge", "sdk-kernel-plugin-shell-scripted", "sdk-kernel-plugin-tool-shell", "sdk-kernel-plugin-search-files", "sdk-kernel-plugin-tool-search"], externals: [], restricted: ["node"] },
    ],
  },
}

export default config
