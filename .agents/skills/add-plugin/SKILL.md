---
name: add-plugin
description: Checklist for adding a first-party plugin (definePlugin) or a new @xandreed/* package — the registration lists the quality/package-registered gate checks, definePlugin conventions (ids, scope, provides/requires, options merged over defaults), docs:generate, tests and the CHANGELOG. Read before creating packages/<name> or a new definePlugin.
---

# Add a plugin or a package

A package is gated, built and published only once it is listed by hand.
`bun run typecheck` fails (`quality/package-registered`) naming each list a
package under `packages/` is missing from; the lists are the `registration`
data in `foundry.config.ts`.

## A. New package (skip when the plugin goes into an existing one)

1. `packages/<name>/package.json` (copy `packages/plugin-tasks/package.json`):
   `"name": "@xandreed/<name>"`, the shared `version` (as in every other
   package), `engines` (the build refuses a manifest without it),
   `"main": "./src/index.ts"`, `"exports": { ".": "./src/index.ts" }`,
   internal dependencies as `workspace:*`, `effect` at the repo's version.
   Copy `packages/plugin-tasks/tsconfig.json` too.
2. `tsconfig.base.json` `compilerOptions.paths`:
   `"@xandreed/<name>": ["packages/<name>/src/index.ts"]`.
3. `foundry.config.ts`:
   - add `"packages/<name>/src/**"` to `CHECKED`;
   - add a `boundaries.layers` entry: `canImport` names only packages beneath
     it (`["core"]` for a plugin; an `@xandreed/*` import is checked against
     it and the target's `exports`), `externals` is the exact allowlist of
     the third-party imports;
   - add `"packages/<name>/src/index.ts"` to `CURATED_ENTRIES`, and the
     file of each subpath its `exports` adds: `quality/exports-have-consumers`
     then wants each export imported by another package, a script or a doc
     code block, or tagged `@public` at its declaration (host API: the
     plugin, whose tag covers the default export, its layer, its config and
     defaults, a port, an adapter, an error a host matches, a kit);
   - if its tests import more (sdk, runtime, other plugins), add a
     `<name>-tests` layer BEFORE the package's entry (the first match wins; see
     `plugin-tasks-tests`) and the matching `devDependencies`. Read the
     comment above `plugin-workspace-tests` first: never make two packages
     devDependencies of each other.
4. `scripts/build-packages.ts`: add the directory name to `names`.
5. A plugin package: import it in `scripts/generate-plugin-reference.ts` and
   add its plugins to `firstParty` (docs:generate also exits 1 for any
   exported plugin missing there).
6. Behaviour worth proving on Node goes in `scripts/verify-packages.ts` (the
   plain Node import of every package already runs there).
7. `packages/<name>/AGENTS.md` (short: what it provides, its rules, its
   layout; see `packages/plugin-telemetry/AGENTS.md`), then
   `ln -s AGENTS.md packages/<name>/CLAUDE.md`, and a row in the README's
   package table.

## B. The plugin

```ts
// packages/plugin-tasks/src/plugin.adapter.ts
export const tasksPlugin = definePlugin({
  id: "@xandreed/plugin-tasks", version: "0.14.0", scope: "runtime",
  config: TasksConfig, defaults: tasksDefaults,
  requires: [Sessions, TaskRunner, TaskExecutor],
  provides: [Tasks],
  contributes: [Capabilities],
  layer: (config) => Layer.mergeAll(TasksLive(config), Layer.succeed(Capabilities, config.tools ? [tasksCapability] : [])),
})
export const TasksPluginLive = tasksPlugin.live
export default tasksPlugin
```

- Define it in a `.adapter.ts` file, usually `plugin.adapter.ts`.
- `id`: `@xandreed/<package>`, or `@xandreed/<package>/<part>` for a second
  plugin of the package (`@xandreed/plugin-render/feed`). Never change a
  shipped id. `version`: the shared version.
- `scope: "runtime"` when it is built once per agent and runtime plugins may
  require it; `"session"` (the default) when it needs a turn's services
  (`RunContext`, `TurnEvents`, `UtilityLlm`). A runtime plugin cannot require
  a session service.
- `config`: a `Schema.Struct` in an entity file, exported with its defaults
  (`TasksConfig`, `tasksDefaults` in `task-records.entity.ts`). Keep it
  flat; group keys in a nested struct only when they belong together
  (`inbox: { maxPending, attempts }` in plugin-sessions). Document each key.
- Options merge over the defaults with `mergeOptions` (core,
  `harness/plugin.entity.functions.ts`): plain objects key by key at every
  depth, arrays and strings replace, and an object of another union member
  replaces its default (`{ ownership: { mode: "process" } }`). Unknown keys
  fail with `config.options`. Do not merge options yourself in `layer`.
- `requires`, `provides`, `optional` list service classes; tools, skills and
  prompt sections arrive through `contributes: [Capabilities]`. The layer
  may need only what `requires` lists (a Reference needs no entry): one that
  needs another service does not compile, so declare it rather than widen a
  type. Read an `optional` service with `Effect.serviceOption`, and list in
  `optional` a service the plugin reads that way per turn too. A tool lists
  the services its handler reads in `defineTool`'s `requires` (one it reads
  without listing does not compile); a run lacking one fails to open its
  tools with `requires.missing`. A prompt section that reads services is
  built with `definePromptSection` and lists them in its `requires` the same
  way (a plain `PromptSection` reads none).
- Export `<thing>Plugin`, `<Thing>PluginLive = <thing>Plugin.live`, the
  config schema and the defaults, by name from `src/index.ts` (never
  `export *`), each tagged `@public` at its declaration unless another
  package imports it; `export default` the package's main plugin. Leave a
  helper only the package uses unexported from the entry.
- A plugin builds only its own services from what it requires. Agents are
  composed by `Agent.define({ plugins })` or a host's `stackPlugins`; a
  package has no composition root.
- Any text it shows the model follows the `write-model-text` skill; a new
  port follows `add-port`; a new event follows `change-event`.

## C. References and docs

1. `bun run docs:generate`; keep `docs/plugin-reference.json` and
   `packages/website/src/content/docs/concepts/plugin-reference.md` in the diff.
2. User docs in the same PR: its section in `docs/framework.md` and the
   matching page under `packages/website/src/content/docs/concepts/`. Every
   `@xandreed/*` import in their code fences must resolve in the packed
   packages (`bun run verify:packages` compiles them).
3. CHANGELOG entry under Unreleased (`### Added`). A new package first ships
   with the next version bump (skill `release`).

## D. Tests

- Pure parts: unit tests beside their `.entity.functions.ts`.
- Behaviour: a key-free journey through `Agent.define` with a scripted model
  (skill `journey-test`); it needs the `-tests` layer from A.3.
- Each adapter of a port runs that port's conformance kit (skill `add-port`).

## Checklist

- [ ] package.json, tsconfig, `paths`, `CHECKED`, `CURATED_ENTRIES`, boundaries layer (and `-tests` layer), build `names`, `firstParty`
- [ ] AGENTS.md + CLAUDE.md link, README row
- [ ] `definePlugin` in a `.adapter.ts`; id, version, scope, flat documented config, defaults exported
- [ ] Plugin, `PluginLive`, config and defaults exported from `src/index.ts`
- [ ] docs:generate output, framework.md and website page in the diff
- [ ] Unit tests, a journey, kits for its adapters; CHANGELOG entry

```bash
bun run typecheck && env -u HTTP_PROXY -u HTTPS_PROXY bun test
bun run build:packages && mkdir -p .artifacts/tmp && TMPDIR=$PWD/.artifacts/tmp bun run verify:packages
bun run docs:generate && git status --porcelain -- docs packages/website/src/content/docs   # CI: empty once committed
```
