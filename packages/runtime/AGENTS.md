# @xandreed/runtime

The plugin graph: resolves a `HarnessConfig` against the installed plugins (instances, options, bindings, dependency order), activates it one scope at a time, fingerprints it, and keeps replaceable layers as scoped generations. `Agent.define` (sdk) is built on it. Node 24 and Bun; layer `runtime` in `foundry.config.ts` (imports core; `node:crypto` for the fingerprint).

## Rules

- Know plugins only by what they declare (`provides`, `contributes`, `requires`, `optional`, `scope`); import no plugin package here.
- A plugin's layer gets only the services it declares plus the fiber's settings (`fiberSettings`, `src/graph.ts:100-104`): add a fiber reference there, never pass the caller's context through.
- Refuse every invalid configuration with a `HarnessError` (`config.graph`, `config.options`, `config.profile`), never ignore it: profiles are refused, unknown option keys fail.
- Options are core's `mergeOptions` over the plugin's defaults, decoded with `onExcessProperty: "error"`.
- A runtime-scoped plugin never depends on a session-scoped service, and a key is provided or contributed, never both.
- Contributed keys are arrays, concatenated in graph order; a consumer is activated after every other contributor.
- `graphFingerprint` hashes canonical JSON (sorted keys); change what it hashes only on purpose: it is `Agent.fingerprint`.
- Keep `makeLiveLayer`'s guarantees: a failed stage never replaces the working generation, a retired one closes after its last lease, scopes close outside the gate.

## Public surface

- `resolveGraph(config, plugins, external?)`: validates the instances, plugin API versions, options and bindings, and orders the nodes by dependency (`PluginGraph`, `PluginNode` are its types).
- `activateGraph(graph, lifetime, services, scope)`: builds the nodes of one scope (`runtime` or `session`) in order, checks each provided what it declared, and returns the merged context. A service named `external` in `resolveGraph` that a plugin requires must be in `services` (or provided by an earlier node): a `definePlugin` plugin fails its activation with `requires.missing` without it.
- `graphFingerprint(graph, scope?)`: sha256 of the instances, bindings and, unless `scope` is `runtime`, the system prompt.
- `makeLiveLayer(layer)`: scoped generations of a layer, with `use`, `generation` and `replace`.

The root names each export, and `quality/exports-have-consumers` checks each one: sdk imports the graph functions and types, and `makeLiveLayer`, which no first-party package imports, is tagged `@public` (docs/service-generations.md documents it).

No plugins.

## Model-facing text

None.

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/graph.ts` | `resolveGraph`, `activateGraph`, `graphFingerprint` |
| `src/live-layer.adapter.ts` | `makeLiveLayer` |
| `src/testing.port.ts`, `src/testing/version.port.ts` | test-only services (not exported; the build leaves them out) |
| `src/index.ts` | the public exports |

## Tests

- `src/graph.test.ts`: ordering, refusals, bindings, contributions, declared services only, option merging, refused profiles, key-order-free fingerprints.
- `src/live-layer.test.ts`: leased generations drain, failed stages keep the working layer, uses continue during a replacement, closing during a replacement.
- The sdk's tests (`Agent.define`) and plugin-workspace's plugin tests resolve and activate real graphs.
- Run: `bun test packages/runtime`.

See the root AGENTS.md for the enforced rules and the definition of done.
