# @xandreed/evals-langsmith

Exports a saved `EvaluationRun` to LangSmith through its official client (`langsmith`): a project, one run per trial and one feedback per measured metric, behind the `EvaluationExport` port of `@xandreed/evals`. Node 24 (the declared engine; the tests run on Bun); layer `evals-langsmith` in `foundry.config.ts` (imports `@xandreed/evals`, `langsmith` and `node:` only).

## Rules

- Construct the client inside `exportRun`, never when the exporter is registered: an app's `exporters` list must open nothing.
- Send only the run as `EvaluationRun` encodes it (an absent value is `null`, never an `Option`); its scores are the ones `exportableScores` (`@xandreed/evals`) lists, the score mapping both exporters share.
- Derive every remote id from a local one (`remoteId`: a UUID-shaped SHA-256 of the trial id or of a score's `seed`, `<trial>/<grader>/<version>/<scope>/<metric>`). Never change `remoteId` or a seed: exporting a run again must reach the runs and feedback the last export made (`src/export.test.ts:217` pins them).
- Keep exports repeatable: a create refused as a conflict (`LangSmithConflictError`, HTTP 409) becomes an update of the same id (`upsert`).
- Send each score `exportableScores` lists (the `scored` grades' `boolean`, `score` and `probability` metrics, a boolean as 0 or 1; `preference` stays local) as feedback keyed by its `key`, `<grader>@<version>/<scope>/<metric>`, with the grade's context and usage.
- Stamp the receipt's `at` with `Clock.currentTimeMillis`, never `Date.now()`.
- Flush the runs before sending feedback; keep both fan-outs bounded (`concurrency: 8`).
- Bound every export: the client is built with `timeout_ms: 30_000` per request (it does not resend one that timed out; it retries other failures up to 4 times, a number this client version fixes), and the whole export, `flush` included, runs under `timeoutMs` (default 300 000), past which it fails as `provider`. The client takes no signal per request, so an interrupted export returns at once and stops waiting for the requests in flight.
- Fail with an `EvaluationError` (`invalid` when the run does not encode, `provider` for the service) that keeps the schema or client error as `cause`; the message is `LangSmith export: ` and the client's reason (`reasonOf(Cause.die(error))`), never `String(error)`. The local report is never touched.
- `exportRun` is one `eval.export` span (`Effect.fn`) carrying `eval.exporter: "langsmith"` and the run's `eval.run.id`.

## Public surface

- `langsmithExporter(options)`: an `ExporterRegistration` with id `langsmith`, for an app's `exporters` (the CLI's `--exporter langsmith`).
- `EvaluationExportLangSmithLive(options)`: the `EvaluationExport` layer itself; `LangSmithExportOptions` (`apiUrl`, `apiKey`, `project`, optional `timeoutMs`; `webUrl`, else `apiUrl`, is the receipt's `url`).

The root names each export, and `quality/exports-have-consumers` checks each one: the packed consumer imports `langsmithExporter`, and `EvaluationExportLangSmithLive` and `LangSmithExportOptions`, which no first-party code imports, are tagged `@public`.

## Model-facing text

None.

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/langsmith-export.adapter.ts` | the export service, its layer and its registration |
| `src/index.ts` | re-exports the adapter |

## Tests

- `src/export.test.ts:98` and `:109`: the evals fixture app (`@xandreed/evals/testing/fixture.testing`) exported to a key-free `Bun.serve` stand-in that answers a repeated create with 409; the second export must update, not duplicate.
- `src/export.test.ts:131`: a request refused with 401 fails as `provider`, the client's error as its cause.
- `src/export.test.ts:154`: an export is one `eval.export` span with the exporter and run ids.
- `src/export.test.ts:186` and `:202`: a stand-in that never answers fails the export as `provider` once `timeoutMs` passes, and an interrupted export returns at once.
- `src/export.test.ts:217`: the run, feedback and mapping ids are the literal ids earlier releases derived.
- `src/export.test.ts:235`: the receipt's `at` is `TestClock`'s time.
- `bun run verify:packages` imports the packed exporter on Node (`scripts/evaluation-consumer.fixture.mjs`).
- Run: `env -u HTTP_PROXY -u HTTPS_PROXY bun test packages/evals-langsmith`.

See the root AGENTS.md for the enforced rules and the definition of done.
