# @xandreed/evals-langsmith

Exports a saved `EvaluationRun` to LangSmith through its official client (`langsmith`): a project, one run per trial and one feedback per measured metric, behind the `EvaluationExport` port of `@xandreed/evals`. Node 24 (the declared engine; the tests run on Bun); layer `evals-langsmith` in `foundry.config.ts` (imports `@xandreed/evals`, `langsmith` and `node:` only).

## Rules

- Construct the client inside `exportRun`, never when the exporter is registered: an app's `exporters` list must open nothing.
- Send only the run as `EvaluationRun` encodes it (an absent value is `null`, never an `Option`).
- Derive every remote id from a local one (`remoteId`: a UUID-shaped SHA-256 of the trial id or `<trial>/<grader>/<version>/<scope>/<metric>`).
- Keep exports repeatable: a create refused as a conflict (`LangSmithConflictError`, HTTP 409) becomes an update of the same id (`upsert`).
- Export only `scored` grades' `boolean`, `score` and `probability` metrics, as feedback keyed `<grader>@<version>/<scope>/<metric>` with the grade's context and usage.
- Flush the runs before sending feedback; keep both fan-outs bounded (`concurrency: 8`).
- Fail with an `EvaluationError` (`invalid` when the run does not encode, `provider` for the service) that keeps the schema or client error as `cause`; the message is `LangSmith export: ` and the client's reason (`reasonOf(Cause.die(error))`), never `String(error)`. The local report is never touched.
- `exportRun` is one `eval.export` span (`Effect.fn`) carrying `eval.exporter: "langsmith"` and the run's `eval.run.id`.

## Public surface

- `langsmithExporter(options)`: an `ExporterRegistration` with id `langsmith`, for an app's `exporters` (the CLI's `--exporter langsmith`).
- `EvaluationExportLangSmithLive(options)`: the `EvaluationExport` layer itself; `LangSmithExportOptions` (`apiUrl`, `apiKey`, `project`; `webUrl`, else `apiUrl`, is the receipt's `url`).

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

- `src/export.test.ts:96` and `:107`: the evals fixture app (`@xandreed/evals/testing/fixture.testing`) exported to a key-free `Bun.serve` stand-in that answers a repeated create with 409; the second export must update, not duplicate.
- `src/export.test.ts:129`: a request refused with 401 fails as `provider`, the client's error as its cause.
- `src/export.test.ts:152`: an export is one `eval.export` span with the exporter and run ids.
- `bun run verify:packages` imports the packed exporter on Node (`scripts/evaluation-consumer.fixture.mjs`).
- Run: `env -u HTTP_PROXY -u HTTPS_PROXY bun test packages/evals-langsmith`.

See the root AGENTS.md for the enforced rules and the definition of done.
