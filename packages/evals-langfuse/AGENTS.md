# @xandreed/evals-langfuse

Exports a saved `EvaluationRun` to Langfuse through its official client (`@langfuse/client`): one trace per trial and one numeric score per measured metric, behind the `EvaluationExport` port of `@xandreed/evals`. Node 24 (the declared engine; the tests run on Bun); layer `evals-langfuse` in `foundry.config.ts` (imports `@xandreed/evals`, `@langfuse/client` and `node:` only).

## Rules

- Construct the client inside `exportRun`, never when the exporter is registered: an app's `exporters` list must open nothing.
- Build trace bodies from the run as `EvaluationRun` encodes it (an absent value is `null`, never an `Option`); scores read only plain fields.
- Derive every remote id from a local one (`remoteId`, SHA-256 of the trial id or `<trial>/<grader>/<version>/<scope>/<metric>`), so the receipt's `mappings` lead back.
- Export only `scored` grades' `boolean`, `score` and `probability` metrics, as `NUMERIC` scores named `<grader>@<version>/<scope>/<metric>`; `preference` stays local.
- Send at most 50 events per ingestion batch; any rejected event fails the export as `provider`.
- Bound every export: each ingestion request passes its `abortSignal` (the `Effect.tryPromise` signal), `timeoutInSeconds: 30` and `maxRetries: 2`, at most 4 batches are in flight, and the whole export runs under `timeoutMs` (default 300 000), past which it fails as `provider`. Interrupting an export aborts its requests in flight.
- Fail with an `EvaluationError` (`invalid` when the run does not encode, `provider` for the service) that keeps the schema or client error as `cause`; the message is `Langfuse export: ` and the client's reason (`reasonOf(Cause.die(error))`), never `String(error)`. The local report is never touched.
- `exportRun` is one `eval.export` span (`Effect.fn`) carrying `eval.exporter: "langfuse"` and the run's `eval.run.id`.

## Public surface

- `langfuseExporter(options)`: an `ExporterRegistration` with id `langfuse`, for an app's `exporters` (the CLI's `--exporter langfuse`).
- `EvaluationExportLangfuseLive(options)`: the `EvaluationExport` layer itself; `LangfuseExportOptions` (`baseUrl`, `publicKey`, `secretKey`, optional `timeoutMs`; `project` is accepted but not read).

## Model-facing text

None.

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/langfuse-export.adapter.ts` | the export service, its layer and its registration |
| `src/index.ts` | re-exports the adapter |

## Tests

- `src/export.test.ts:12`: runs the evals fixture app (`@xandreed/evals/testing/fixture.testing`) and exports it to a key-free `Bun.serve` stand-in on loopback.
- `src/export.test.ts:97`: an ingestion refused with 401 fails as `provider`, the client's error as its cause.
- `src/export.test.ts:126`: a failed export is still one `eval.export` span with the exporter and run ids.
- `src/export.test.ts:178` and `:194`: a stand-in that never answers fails the export as `provider` once `timeoutMs` passes, and an interrupted export aborts its request (the stand-in sees `request.signal` abort).
- `bun run verify:packages` imports the packed exporter on Node (`scripts/evaluation-consumer.fixture.mjs`).
- Run: `env -u HTTP_PROXY -u HTTPS_PROXY bun test packages/evals-langfuse`.

See the root AGENTS.md for the enforced rules and the definition of done.
