# Efferent — composable agent framework on Effect 4.0.7, for Node and Bun

Rules for changing this repository. Contract: `README.md`, `docs/framework.md`.
Human process: `CONTRIBUTING.md`. A package's own rules:
`packages/<name>/AGENTS.md`. `CLAUDE.md` links here. Skills, in
`.agents/skills/<name>/SKILL.md` (linked from `.claude/skills`):
`commit-style`, `add-plugin`, `add-port`, `write-model-text`, `effect-idioms`,
`domain-entity`, `change-event`, `journey-test`, `release`.

## Task map

| Task | Read first |
|---|---|
| Write a commit, or a squash-merged PR's title and body | skill `commit-style` |
| Add a package or a plugin | skill `add-plugin` |
| Add or change a port, an adapter or a conformance kit | skill `add-port`, `packages/core/AGENTS.md` |
| Add or change text the model reads | skill `write-model-text` |
| Write Effect code, or tsc rejects an Effect 3 name | skill `effect-idioms` |
| Add or change an entity or a stored field | skill `domain-entity` |
| Add or change an event, a journal kind or a stored payload | skill `change-event` |
| Test a plugin end to end through `Agent.define` | skill `journey-test` |
| Bump the version, publish or tag (only on explicit sign-off) | skill `release` |
| Change a gate rule, a layer or the registration lists | `foundry.config.ts`, `packages/foundry/AGENTS.md` |

## Architecture

- `core`: shared schemas, ports, conformance kits and protocol helpers.
- `runtime` → core: the plugin dependency graph and scoped plugin activation.
- `sdk` → runtime, core: `Agent.define` and `Agent.turn`, the composable agent over sessions, and the turn engine they run on (`TurnLive` and the turn's lifecycle), with the `ToolRegistry` kit that runs turns over it (`@xandreed/sdk/conformance`).
- `plugin-*` → core: independently configurable capabilities, the agent loop included.
- `evals` ← `evals-cli`, `evals-langfuse`, `evals-langsmith`: tasks, trials, graders, suites; the CLI and exporters run on Node 24.
- `foundry` runs the gates (development tooling); `website` is the docs site. Neither is published.

The `boundaries` layers in `foundry.config.ts` enforce the direction (a
`<name>-tests` layer before a package's widens it for tests); inside core,
layers by role do (`packages/core/AGENTS.md`). Everything but
`plugin-session-sqlite` (`bun:sqlite`) also loads on Node 24. Session data
defaults to `.efferent/runtime`: never delete old local data to reset it.
Build output goes under `.artifacts`.

## Gate rules

`bun run typecheck` runs the repo profile (`foundry.config.ts`) over every
file under `packages/*/src`, tests included (tsc errors are `ts/<code>`), then
tsc over `scripts/`; `fixtures/` are outside it. The baseline stays empty.
`no-as-never`, `no-unknown-requirements` and the rules from `no-json-parse` to
`require-concurrency-option`, but `no-instanceof-tagged-error`, skip test
code (`*.test.ts`, `*.bench.ts`, `testing.ts`, `*.testing.ts`,
`testing.port.ts`, `testing/`); `no-error-code-compare` and
`no-provider-namespace` also skip kits (`*.conformance.ts`). A new rule
with findings enters one package at a time, through a list in
`foundry.config.ts` of the packages it runs in: to add a package, fix its
findings and add its line, never the baseline; once the list names every
package, the rule takes `CHECKED` and the list is deleted. An `allow` list
(`ROLELESS_FILES`, `NULLABLE_EDGES`, `RECORD_CAST_EDGES`, `UNKNOWN_JSON_EDGES`, `UNKNOWN_REQUIREMENT_EDGES`)
or a `boundary` (`ERASURE_BOUNDARY`) only shrinks: an entry that excuses
nothing fails.

| Rule | Bans | Fix |
|---|---|---|
| `effect/no-try-catch` | `try`/`catch`, `throw`, a non-Effect `.catch()` | `Effect.fail`/`Effect.die`, `Effect.catch`/`Effect.catchTag`; foreign promises via `Effect.tryPromise` |
| `effect/no-let` | `let`, `var` | a fold: `Effect.reduce`, a recursive Effect step, Array combinators, or a `Ref` |
| `effect/no-loop-statements` | `for`, `for…of`, `for…in`, `while`, `do` | `Effect.forEach`, `Effect.repeat({ while })`, `Effect.whileLoop`, Array combinators (`Effect.iterate` does not exist) |
| `effect/no-nullable-return` | an exported function returning `A \| undefined` or `A \| null` | `Option<A>` (`Option.fromNullishOr` at the edge) |
| `effect/match-over-tag-switch` | a `switch`, an else-if ladder, an if-return ladder (adjacent `if (x._tag === …) return …`) or a ternary chain on `_tag`, `.type`, `.role` or `.mode` | `Match.valueTags(x, { … })`, `Match.value(x).pipe(Match.tag(…), Match.exhaustive)`, `Match.discriminators("type")`, `Option.match`, `Result.match`, `Exit.match`; `Match.orElse` for a deliberate default |
| `effect/no-as-any` | `as any`, `as unknown as T` | decode with Schema, or fix the type |
| `effect/no-as-never` | `as never` outside the `ERASURE_BOUNDARY` files; `as never as T` everywhere, those files included | fix the type; a file added to `ERASURE_BOUNDARY` states its reason in the PR |
| `effect/no-unknown-requirements` | an `Effect`, `Stream` or `Layer` type with `unknown` as its requirements (`UNKNOWN_REQUIREMENT_EDGES` aside) | name the services in R (`never` for none) or keep R a type parameter; services a config picks at run time are declared by key and checked where they are provided |
| `effect/no-parallel-interface` | an interface shadowing a same-named schema | `type X = typeof X.Type` |
| `effect/no-json-parse` | `JSON.parse` | decode with `Schema.fromJsonString(S)` (`decodeUnknownEffect`, `decodeUnknownResult`, `decodeUnknownOption`); `S` is `Schema.Json` when the shape is open |
| `effect/no-sync-codec` | `decodeSync`, `decodeUnknownSync`, `encodeSync`, `encodeUnknownSync` | the Effect, Result or Option codec, its failure handled |
| `effect/no-unknown-json` | `Schema.Record(Schema.String, Schema.Unknown)`, `Schema.fromJsonString(Schema.Unknown)`, but as the argument of a `Schema.encode*` call (`UNKNOWN_JSON_EDGES` aside) | decode the shape that is read; `Schema.Json` or `Schema.JsonObject` for JSON that stays open |
| `effect/no-record-cast` | `as Record<string, unknown>`, `as Record<string, any>`, `as { … }` (`RECORD_CAST_EDGES` aside) | decode with a Schema, narrow with `Predicate.hasProperty`, or fix the type at its source |
| `effect/no-provider-namespace` | in core and the agent loop (`PROVIDER_NEUTRAL`): an `anthropic`, `openai`, `google` or `router` key, written, typed, destructured or read | carry provider metadata and options opaque (`ProviderOptions`); core's own fields go under `ENGINE_KEY` (`stampResponseModel`, `responseModelOf`); code for one provider lives in the models plugin |
| `effect/no-cause-pretty-data` | `Cause.pretty` anywhere but an `Effect.log*` argument | log the cause; data keeps `Cause.prettyErrors` messages or `reasonOf` |
| `effect/no-effect-promise` | `Effect.promise` | `Effect.tryPromise` with a typed error, logged or handled |
| `effect/no-promise-all` | `Promise.all`, `Promise.allSettled` | `Effect.forEach` or `Effect.all` with a stated `concurrency` |
| `effect/callback-buffer-size` | `Stream.callback` without a `bufferSize` | pass `{ bufferSize }` |
| `effect/bounded-pubsub` | `PubSub.unbounded`, or `bounded`, `sliding` or `dropping` with an infinite capacity | a finite capacity: `PubSub.sliding(n)` (a wake-up signal: `sliding(1)`, which never loses the last), `bounded(n)` or `dropping(n)` |
| `effect/no-process-env` | `process.env` outside a `main.ts` and the bash adapter (`ENVIRONMENT_EDGES`) | `Config.String`, `Config.Redacted`, `Config.option`: the ConfigProvider supplies it |
| `effect/no-ambient-time-random` | `Date.now`, `new Date()` without arguments; `Math.random`, `randomUUID` outside `*.adapter.ts` files | `Clock.currentTimeMillis`, in adapters too; `Random` (core's `randomUuid` for ids) |
| `effect/no-locale-compare` | `.localeCompare` | `Order.String` |
| `effect/require-sort-comparator` | `.sort()` or `.toSorted()` without a comparator | `Arr.sort(xs, Order.String)`, or a comparator |
| `effect/no-instanceof-tagged-error` | `instanceof` a tagged class (`instanceof Error` is fine) | `Effect.catchTag`, `Predicate.isTagged`, `isHarnessError`, `isTurnError`; not `Schema.is` of the class, which checks the class too |
| `effect/no-silent-ignore` | a bare `Effect.ignore` or `Effect.ignoreCause`, `Effect.catch(() => Effect.void)`, `Effect.catchCause(() => Effect.void)`, `Effect.orElseSucceed`, unless an `Effect.tapError`/`tapCause` that logs comes first in the pipe | `Effect.ignore({ log: "Warn", message: "…" })` (`"Debug"` for an expected miss), a logging tap before it, or `Effect.catchTag` for the one expected failure |
| `effect/no-option-unwrap` | `Option.getOrNull`, `Option.getOrUndefined` outside `*.adapter.ts` files and kits | `Option.match`, `Option.getOrElse` with a real default, an optional field spread from `Option.match`; unwrap in the adapter that writes the wire |
| `effect/no-stringified-cause` | `String(e)`, `${e}` or `"…" + e` of a failure inside a tagged error's fields | keep the failure as a value (a `cause` field: `harnessError(code, message, cause)`) and say what failed; text from `reasonOf(cause)` |
| `effect/no-error-code-compare` | `x.code === "<literal>"` outside the file that declares the error and its `.functions.ts` (kits may compare) | a guard the owning module exports (`isStoreBusy`, `isUnavailable`), `harnessCodeOf(e)` for the framework's code of any failure, or a tagged error matched with `Effect.catchTag` |
| `effect/no-code-property-guard` | `Predicate.hasProperty(x, "code")` (either form), `"code" in x` | `errorCodeOf(e)` for a Node or SQLite code (`Option.contains(errorCodeOf(e), "ENOENT")`; evals packages take evals' copy), `harnessCodeOf(e)` for the framework's codes, `Effect.catchTag` for a tagged error |
| `effect/prefer-effect-fn` | an exported function or a service method that only returns `Effect.gen(…)` | `Effect.fn("area.op")(function* (…) { … })`; `Effect.fnUntraced` for a hot helper |
| `effect/require-concurrency-option` | `Effect.forEach` or `Effect.all` over more than one effect without `concurrency` | state it: `1` when order, a shared resource or the first failure matters; a number or a config value for independent I/O |
| `effect/branded-id-fields` | in every package's `*.entity.ts` files (and core's `src/spec`): an unbranded id field (`id`, `<x>Id`), also through `.check(…)`, a wrapper (`optionalKey`, `OptionFromNullOr`, `Array`, `withDecodingDefaultKey`, …) or a const of the same file | a brand at the id's definition; reuse it wherever that id is held |
| `quality/no-skipped-tests` | `.skip`, `.todo`, `.only`, `xit`, `xdescribe`, `xtest` | fix or delete the test; one that needs an environment uses `test.skipIf` |
| `quality/no-empty-catch` | an empty `catch` block | handle the failure as a value |
| `quality/exports-have-consumers` | per entry (the entry files `CURATED_ENTRIES` lists): an export of a package entry that no other package, script or doc code block imports and that has no `@public` tag; `export *` in an entry; a `@deprecated` export that first-party code still imports | import it where it is used, tag documented host API `@public`, or stop exporting it; name each export; move a deprecated export's importers to its replacement |
| `architecture/no-raw-promise-core` | `await`, `async`, `Promise`, `.then`, `Effect.run*` in entity and use-case files | Effect values; promises belong in an adapter |
| `architecture/no-runtime-imports-core` | `node:`, `bun` and host imports in entity and use-case files | a port, implemented in a `.adapter.ts` |
| `architecture/contracts-contain-no-behavior` | an exported function in a `.entity.ts` or `.usecase.ts` | the paired `.functions.ts` file |
| `architecture/context-tags-live-in-ports` | `Context.Service` outside `.port.ts` files and `ports/` folders | move the contract to a port file |
| `architecture/layers-live-at-edges` | `Layer.*` in entity and use-case files | build the Layer in a `.adapter.ts` |
| `architecture/role-suffix-required` | a file under `packages/*/src` (foundry aside) whose name has none of the roles below and is not on the frozen `ROLELESS_FILES` | name it for its role; a renamed or split file leaves the list in the same change |
| `boundaries/illegal-import` | an import into a layer that `canImport` does not list, relative or by package name (`@xandreed/<pkg>[/<sub>]` reaches the layer of the package's entry); a subpath the package's `exports` lacks (a `-tests` layer may reach a `testing` module); a `restricted` subpath not granted as `<layer>/<sub>`; a relative import that leaves its package | invert the dependency or move the code; import what the package exports |
| `boundaries/illegal-external` | a bare import that names no workspace package, missing from the layer's `externals` | depend downward; widening `externals` is a reviewed change |
| `quality/package-registered` | a package missing from a list the gates or the build read | add it where the message says (skill `add-plugin`) |
| `quality/baseline-empty` | any fingerprint in `.foundry/baseline.json` | fix the finding; never `--update-baseline --allow-grow` |
| `quality/no-private-text` | in any file git tracks: a home path (`/home/<name>/`, `/Users/<name>/`, `C:\Users\<name>\`) but a placeholder one, or a term of the git-ignored local denylist `.foundry/private-terms.txt` | a relative path or a placeholder home (`/home/user/`); remove the term |

## File roles

"Base" is every rule above except the four that look only at entity and
use-case files: `no-raw-promise-core`, `no-runtime-imports-core`,
`contracts-contain-no-behavior` and `layers-live-at-edges`.

| File | Holds | Gates that see it |
|---|---|---|
| `x.entity.ts`, `x.usecase.ts` | schemas, brands, tagged errors, derived types | base + those four |
| `x.entity.functions.ts`, `x.usecase.functions.ts` | the pure behaviour of that pair | base + `no-raw-promise-core`, `no-runtime-imports-core`, `layers-live-at-edges` |
| `x.port.ts`, `ports/*` | `Context.Service` contracts | base |
| `x.adapter.ts` | `<Thing>Live` Layers, `definePlugin`, IO | base except `no-option-unwrap`; `no-ambient-time-random` flags the wall clock only |
| `x.conformance.ts` | a port's kit, exported and shipped | base except `no-option-unwrap`, `no-error-code-compare` and `no-provider-namespace` |
| `index.ts`, `main.ts` | the public surface, as explicit named exports; a command line's entry | base (`main.ts` may read `process.env`) |
| `x.test.ts`, `testing.ts`, `x.testing.ts` | tests beside their source; scaffolding the build does not ship | base except `no-as-never`, `no-unknown-requirements` and the rules from `no-json-parse` to `require-concurrency-option` but `no-instanceof-tagged-error` |
| any other name (`loop.ts`) | older modules, listed in `ROLELESS_FILES` | base; `role-suffix-required` refuses a new one: give it one of the roles above |

## Ports, adapters and composition

- Ports are `Context.Service` classes in a `.port.ts` file or a `ports/`
  folder: shared ones in `packages/core/src/ports`, a package's own in its
  `src/ports`.
  Methods return `Effect` or `Stream`; expected failures are
  `Schema.TaggedError`s, absence is `Option`.
- Adapters are `<Thing>Live` Layers in `.adapter.ts` files: in-memory ones in
  core, IO ones in plugins. Foreign promises go through `Effect.tryPromise`;
  foreign errors map to the port's error in one function.
- A plugin (`definePlugin`, usually `plugin.adapter.ts`) builds only its own
  services. Agents are composed by `Agent.define` or a host's `stackPlugins`;
  the only `main.ts` files are the `evals-cli` and `foundry` command lines.
- Tool failures are data: the shared `Failure` struct, `failureMode: "return"`.
- Errors are told apart by tag and fields (`Effect.catchTag`,
  `isHarnessError`, `isTurnError`, `harnessCodeOf`), never `instanceof` or
  `Schema.is` of the class. A wrapped failure stays a value in a `cause`
  field; `reasonOf` turns a cause into text; no stack reaches a report or
  the model.

Naming (skill `effect-idioms` §7 has the span policy and names):

- Service methods and exported effectful functions at a service boundary are
  `Effect.fn("area.op")`, named like the spans `agent.turn` and `engine.run`;
  hot internal helpers use `Effect.fnUntraced`.
- Service and reference keys are `@xandreed/<package>/<Name>`. A key is
  public (`provides`, config `bindings`, the plugin reference): never rename
  one, the older `efferent/<Name>` keys included.
- A plugin is `export const <thing>Plugin = definePlugin(...)`, exported by
  name from `src/index.ts`, with the id `@xandreed/<package>` (then also the
  default export) or `@xandreed/<package>/<part>`.

## Model-facing text

Text the model reads is a contract and part of cached prompt prefixes: frame
it with core's `src/turn/model-text.ts` (`hostNote`, `framed`, `clipTo`), pin
it exactly, and follow skill `write-model-text` and `packages/core/AGENTS.md`.
Each package's `AGENTS.md` lists its texts in a "Model-facing text" table
whose "Pinned by" column cites the exact test or golden;
`scripts/model-text-pins.test.ts` fails on a row pinned in part or not at
all, and on a cited test file or line that does not exist.

## Definition of done

`.github/workflows/ci.yml`, in order; tests run with `HTTP_PROXY` and
`HTTPS_PROXY` unset.

```bash
bun install --frozen-lockfile
bun run typecheck
bun packages/foundry/src/main.ts check --config packages/foundry/foundry.config.ts
bun run foundry demo
bun test
bun run build:packages
bun run verify:packages
bun run docs:generate
test -z "$(git status --porcelain -- docs packages/website/src/content/docs)"
bun run --cwd packages/website check
# then the models plugin's proxy tests again, on Bun 1.3.6:
bun test packages/plugin-models/src/llm/openAiCodexWebSocket.test.ts packages/plugin-models/src/plugin.adapter.test.ts packages/plugin-models/src/transport/models-transport.adapter.test.ts
```

These checks are key-free, so they do not show that real provider calls work.
Provider-backed evals need explicit model and credential configuration and
keep candidate, prompt, schema and protocol versions in their evidence.

## Commits and publishing

- Commits are authored as `Xand Reed <xandreed@proton.me>`: check
  `git config user.email` first.
- Commit messages and PR text carry no co-author trailers or assistant
  attribution.
- Keep personal details, local paths and other projects' names out of every
  file, commit, comment and screenshot; never copy code from another project.
- Every PR adds an entry under "Unreleased" in `CHANGELOG.md`.
- Publishing to npm and pushing a `v*` tag (it deploys the docs site) happen
  only on explicit sign-off.
