# ADR 0036: The old engine goes, and the kernel takes the package roots

- **Status:** accepted, 19 November 2026
- **Applies to:** every package. Removed: `@xandreed/runtime`, `@xandreed/process-host`, the sixteen
  `@xandreed/plugin-*` packages, and everything of `@xandreed/core` and `@xandreed/sdk` but their kernels
  (`Agent.define`, the turn engine, core's root, `./conformance` and `./internal`, the sdk's `./conformance`, the
  goldens and the old engine's journals). `@xandreed/core` and `@xandreed/sdk` keep `./kernel` (and the sdk
  `./kernel/node`), and their root entry `.` names the kernel's index. The release line, the release checks, the
  gates, the guides and the docs site follow.
- **Amends:** ADR 0024 (the Node entry becomes `@xandreed/sdk/node` when the kernel moves to the package roots; until
  then it stays `./kernel/node`)
- **Amended:** 19 November 2026, by its second step: each kernel folder is its package's `src`, the entries are
  `@xandreed/core`, `@xandreed/sdk` and `@xandreed/sdk/node`, `./kernel` and `./kernel/node` are gone, and the service
  keys are `@xandreed/<package>/<Name>`, frozen from 0.23.0 ("The second step" below)
- **Skill:** `kernel-architecture` and `release` load this record before a change to the release line or the
  package roots

## Context

The kernel (`@xandreed/core/kernel`, `@xandreed/sdk/kernel`, `@xandreed/sdk/kernel/node`) holds what a host needs:
journals on disk and in SQLite, sessions, memories, tools, approvals, skills, tasks, the inbox, files, a shell and
search, knowledge kept by a curator and recalled by words and by meaning, model providers that charge a spend ledger,
and telemetry. The engine of earlier releases (`Agent.define` and the turn engine in the sdk, core's root and
`./internal`, the runtime's plugin graph, the process host and every `plugin-*` package) was kept beside it until the
kernel caught up. Two engines doubled every gate, guide, fixture and release check, and a reader could not tell which
one to build on.

The kernel's entries were never published: `git show v0.22.0:packages/sdk/package.json` exports no `./kernel`. Nothing
on npm names them, so no alias is owed to anyone.

## Decision

### What goes, and what replaces it

The old engine is deleted before the next release. Each package that goes, and what a host writes instead:

| Package | Replaced by |
|---|---|
| `@xandreed/runtime` (the plugin graph) | Nothing: a kernel plugin is a plain Effect layer, composed with `Layer.provideMerge`; a stack missing a part does not compile |
| `@xandreed/process-host` | None yet |
| `@xandreed/plugin-agent-loop` | The host's own loop over `modelAnswer` and `callTool`, `planned` for retries and fallbacks (ADRs 0003, 0004, 0015) |
| `@xandreed/plugin-memory-window` | `windowMemory` |
| `@xandreed/plugin-memory-summary` | `summaryMemory` over the host's `Summarizer` |
| `@xandreed/plugin-memory-digest` | None yet; a long tool result is sent as its start and a pointer (`pointed`, `ReadResult`, ADR 0011) |
| `@xandreed/plugin-memory` | `curate` and `withKnowledge` (ADRs 0022, 0023); `withFacts` for facts the model keeps itself (ADR 0014); the host's Effect AI `EmbeddingModel` it required: an `Embedder`, `openAiCompatibleEmbedder` on the Node entry (ADR 0032) |
| `@xandreed/plugin-rag` | `withKnowledgeByMeaning` over an `Embedder` and a `VectorStore` recalls memories by meaning (ADR 0025); its `EmbeddingModel`: `openAiCompatibleEmbedder` (ADR 0032); retrieval of a document's passages: none yet |
| `@xandreed/plugin-knowledge-postgres` | None yet: vectors are an index of the journal (`inMemoryVectors`), and journals are on a disk (`directoryJournal`, `sqliteJournal`) |
| `@xandreed/plugin-tool-discovery` | Skills: `defineSkill`, `skills(base, ...skills)` and the `loadSkill` tool (ADR 0013) |
| `@xandreed/plugin-models` | `openAiCompatibleModel` and `anthropicModel` on the Node entry, which charge the ledger (ADR 0026); the router, the credential and settings stores and the subscription sign-ins: none yet |
| `@xandreed/plugin-session-files` | `directoryJournal` (ADR 0024); its `MediaStoreDirectoryLive`: `directoryMedia` on the Node entry (ADR 0034) |
| `@xandreed/plugin-session-sqlite` | `sqliteJournal` (ADR 0024) |
| `@xandreed/plugin-sessions` | `sessions()` over a journal, `recoverTurns`, and the inbox (`inbox`, `inboxOf`) |
| `@xandreed/plugin-tasks` | `tasks(run)` with the `startTask` and `cancelTask` tools (ADR 0018) |
| `@xandreed/plugin-render` | View records (`showView`, `viewsOf`) and live progress (`progressEvent`, ADR 0009); the feed's SSE and WebSocket transports: none yet |
| `@xandreed/plugin-workspace` | `diskFiles`, `processShell`, `filesSearch` and their tools (ADR 0028); image resizing and a skills directory: none yet |
| `@xandreed/plugin-telemetry` | The kernel's spans and metrics, exported with `otlpTelemetry` and `otlpTelemetryFromEnv` (ADR 0030) |
| Core's `MediaStore`, `MediaStoreMemoryLive` and their kit (core's old root, which ADR 0034 left for the old engine) | The sdk kernel's `MediaStore`, `inMemoryMedia` and `mediaStoreConformance` (ADR 0034); media in a message or a tool's result (`toolResultMedia`, `withMediaStore`): none yet, since no record names media |

A local embedder that runs in a Node or Bun process has no replacement yet: the kernel ships `recordedEmbedder` for kits
and tests and the remote `openAiCompatibleEmbedder`, which also reaches a local server that speaks the OpenAI-compatible
wire; the e5 model that runs in a browser worker belongs to the docs site's lessons, not to a published package.

The eighteen packages stay on npm at 0.22.0 as they are: never deprecated, never unpublished, never published again.
The release notes say they are no longer published and what replaces each.

### The kernel takes the package roots, in two steps

Each of `@xandreed/core` and `@xandreed/sdk` needs a root entry: the boundaries gate finds the layer of an import of
`@xandreed/core/kernel` through the package's `.` entry, and the registration gate requires each package's root entry
among the published ones. With the old roots gone, `.` names the kernel's index now, beside `./kernel` (and the sdk's
`./kernel/node`), so this change moves no file and renames no specifier. The next change makes each kernel folder its
package's `src`, renames every `@xandreed/sdk/kernel` specifier to `@xandreed/sdk` (and `./kernel/node` to `./node`) and
drops `./kernel`. This step kept the service keys (`@xandreed/core/kernel/Memory`); the second step renamed them, before any release had them. Since
`./kernel` names the same module as `.`, the API snapshot lists each kernel once, under the root: core's kernel API is
`api/core.api.txt` (ADR 0002's rule now reads that file) and the sdk's `api/sdk.api.txt`; the Node entry keeps
`api/sdk--kernel--node.api.txt`.

While the roots are the kernel's index, the gates read them there:

- The boundaries layers keep their names (`core-kernel`, `sdk-kernel-*`); a package that imports `@xandreed/core` or
  `@xandreed/core/kernel` names `core-kernel`. Core's `restricted` subpaths (`./kernel`, `./internal`) go: they kept
  the old engine and the kernel apart, and nothing is left for them to keep apart. The sdk's `./kernel/node` stays
  restricted, now on the `sdk-kernel` layer that holds the root entry, so the browser entry cannot reach the Node
  entry by the package's name; the eval tests are granted it (`sdk-kernel/kernel/node`).
- The registration gate reads `src/kernel/index.ts` for core and the sdk (`KERNEL_ROOTED` in `foundry.config.ts`), in
  place of `src/index.ts`, until the move.
- The `allow` lists and the boundary that excused only deleted files are deleted with their `allow`, as the gate rules
  say a list that names nothing more is: `ERASURE_BOUNDARY`, `UNKNOWN_JSON_EDGES`, `RECORD_CAST_EDGES`,
  `UNKNOWN_REQUIREMENT_EDGES`, `NULLABLE_EDGES`. `ROLELESS_FILES` keeps the eval packages' files.
- `exports-have-consumers` lost the one importer of the evals' `Journey` (a deleted plugin's test). It stays exported,
  tagged `@public`, because the evals' docs present it as host API (`docs/composable-evaluations.md`, "Journeys";
  `docs/evaluation-domain.md`); no other export lost its last consumer.

### The second step

The next change, before any release, took the second step. `packages/core/src/kernel` is `packages/core/src` and
`packages/sdk/src/kernel` is `packages/sdk/src` (the Node entry `packages/sdk/src/node`), moved whole, so no relative
import inside a kernel changed. Core exports `.` alone; the sdk exports `.` and `./node`, and `main` and `types` are
`./dist/index.*` again. Every specifier followed, in the packages, the scripts and their packed consumers, the guides,
the ADRs before this one, the docs site and the lessons' shown sources: `@xandreed/core/kernel` is `@xandreed/core`,
`@xandreed/sdk/kernel` is `@xandreed/sdk`, `@xandreed/sdk/kernel/node` is `@xandreed/sdk/node`. ADR 0024 keeps the
names it decided under; the changelog's Unreleased entries and the pending changesets keep theirs until the
release's notes are rewritten as the kernel that ships.

- Service keys lose the segment too: a key is `@xandreed/<package>/<Name>` for the package that declares the port
  (`@xandreed/core/Sessions`, `@xandreed/sdk/Curator`), and `@xandreed/sdk/node/<Name>` on the Node entry
  (`@xandreed/sdk/node/CallReach`); test keys follow. `Memory`, declared by the sdk under core's prefix when it moved
  there, is `@xandreed/sdk/Memory`. The first step kept the keys on the rule that a public key is never renamed, but
  no release had shipped them (0.22.0 had no kernel), so they were not public yet; left as they were, they would have
  frozen at their first release with a `/kernel/` segment naming a path that no longer exists. They freeze at 0.23.0.
  No key is stored: no journal record, recorded fixture, lesson data or page storage key holds one, so nothing was
  re-recorded.
- The layers keep their names (`core-kernel`, `sdk-kernel-*`), now over `packages/core/src/**` and
  `packages/sdk/src/**`: renaming them would touch the config, the guides and these records for nothing a reader
  needs. `./node` is the `restricted` subpath of `sdk-kernel`, granted to the eval tests as `sdk-kernel/node`.
- `KERNEL_ROOTED` and the registration gate's two extra registries go: every package's root entry is `src/index.ts`.
- The API snapshot is `api/core.api.txt`, `api/sdk.api.txt` and `api/sdk--node.api.txt`.
- The guide keeps its name, `docs/kernel.md`: the ADRs, the README and the site link it, and the kernel is still
  what it describes.

### What each release check became

| Check | Before | After |
|---|---|---|
| The release line (`names` in `scripts/build-packages.ts`, the Changesets `fixed` group, `releaseDirectories`) | 24 packages | `core`, `sdk`, `evals`, `evals-cli`, `evals-langfuse`, `evals-langsmith` |
| `build:packages` | `main` and `types` always `./dist/index.*` | `main` and `types` from the `.` export (`./dist/kernel/index.*` for core and the sdk until the second step; `./dist/index.*` again after it) |
| The journal fixture (`release:version` records it; `release.yml` requires `packages/sdk/fixtures/journal-<version>.json` to name the version) | An old-engine agent's journals (`Agent.define` over the old plugins), replayed at `STORED_FORMAT` by `packages/sdk/src/journal-compat.test.ts`; other formats refused by Sessions with `session.version` | A kernel host's journals: five turns of a loop over `modelAnswer` and `callTool` with a summary memory wrapped by `withFacts`, a tool call, a fact remembered, an approval for good and a summary, each turn curated into the knowledge session, over `directoryJournal` in a folder under `.artifacts/` (`scripts/record-journal-fixture.ts`). `packages/sdk/src/kernel/node/journal-compat.test.ts` decodes every fixture of today's `JOURNAL_FORMAT` record by record with today's definitions, reads each back by its fold, writes it into a directory journal, reads it back as it is, opens a new turn on each session and builds the summary memory from the stored summary without asking for a new one; a journal of another format (and today's recording stamped with the next format, so the path runs while every fixture is current) is refused where a turn would open (`FormatMismatch`), passed over by `recoverTurns` and left byte for byte. The recorder writes the same bytes each time, and refuses to write a recording that misses a kind of record it must hold (naming each) or whose turns hold under 1.4 times the summary memory's budget (`scripts/journal-fixture-coverage.ts`) |
| The old engine's released journals | `journal-0.13.0.json` to `journal-0.22.0.json` in the tree, byte-identical to their tags, the 0.14.0 one by its hash | They leave the tree: no code is left to replay them. Each stays byte-identical at its tag (`git show v0.22.0:packages/sdk/fixtures/journal-0.22.0.json`) |
| The stored-format record | `STORED_FORMAT`, `docs/stored-format.json` and its generator | Gone: the kernel's format is `JOURNAL_FORMAT` (2), a field of every session's header |
| The plugin versions | `release:version` rewrote each `definePlugin` version | Gone: no plugin carries a version |
| The version markers | README, the getting-started page, the home page, CONTRIBUTING, `docs/roadmap.md`, the `add-plugin` skill | README, the getting-started page, the home page, CONTRIBUTING |
| `docs:generate` | The plugin reference, the event reference, the stored format, the guides' snippets | The guides' snippets alone (`scripts/sync-guides.ts`), with no guide until the kernel's guide has a page |
| `verify:packages` | The old engine's packed consumers and inline checks, the kernel's among them | The build of HEAD, the API snapshot (`api/`), the declarations' imports, one copy of core and Effect, the documentation's imports compiled, every entry loaded on Bun and on Node with a deep import refused, the kernel's packed consumer (`scripts/kernel-consumer.fixture.mjs`) on Node and Bun, the evaluation consumer, and the `efferent-eval` command |
| The publish plan (`publish-plan.ts`, a dry run before the upload) | 24 packages in dependency order | The same rules over 6 |
| The final registry audit (`release:status`) | 24 framework names and `efferent` | The 6 framework names and `efferent`; the 18 retired names are not expected at the new version |
| CI | A pgvector service for the Postgres knowledge store; the models plugin's proxy tests again on Bun 1.3.6 | Both gone, with what they tested |

### The docs

The website's `/docs` keep getting started, which says plainly that the guide is `docs/kernel.md` and the tutorial the
learn track, and the pages of the eval packages and of foundry; the old engine's pages, its two guides and the Plugins
navigation go. The guides of the old engine (`docs/framework.md`, `docs/events.md`, `docs/process-protocol.md`,
`docs/native-knowledge.md`, `docs/knowledge-evaluation.md`, `docs/service-generations.md`, `docs/roadmap.md`) and their
generated references go. The historical records (`docs/framework-reset.md`, `docs/foundry.md`,
`docs/branded-types-roadmap.md`, the repository audit and its resolution) and the accepted ADRs stay as they were
written: they name the old engine because it is what they record.

## Consequences

- There is one way to build an agent here. A host that used the old engine stays on 0.22.0 or writes its program over
  the kernel; the changelog's table says what replaces each package.
- What has no replacement yet is listed above: the process host, document retrieval over passages and its Postgres
  store, the memory digest, the model router, credential and settings stores and subscription sign-ins, the render
  feed's transports, image resizing and a skills directory. Each returns, if it does, as a kernel contract or plugin.
- The next release publishes `@xandreed/core`, `@xandreed/sdk`, the four eval packages and the `efferent` landing
  package, at the package roots once the kernel's folders move.
