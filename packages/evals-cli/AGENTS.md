# @xandreed/evals-cli

The `efferent-eval` command line over `@xandreed/evals`: it loads an app's `eval.config.ts` through `tsx`, runs, calibrates, grades, inspects, compares, reviews and exports, and keeps every result as JSON files on disk. Node 24 (the declared engine; the bin is `src/main.ts`, and the tests run on Bun); layer `evals-cli` in `foundry.config.ts` (imports `@xandreed/evals`, `node:` and `tsx/esm/api` only).

## Rules

- Local files are the result: a run writes `report.json` (`execution.json` with `--execute-only`) and `trials/*.json`; a failed export after it is only a line in `export-receipts.json`.
- Write JSON through `writeJson` (a temporary file renamed into place, mode `0600`, the temporary removed on failure), never in place. A run file (`execution.json`, `report.json`) is `JSON.stringify(run, null, 2)` of the encoded run, written the same way but in parts (`writeRunFile`: the run up to its `trials`, each trial stringified on its own, then the rest), so the trials together may outgrow the longest string; only one trial must fit in one. The one append: a running trial's transcript events, one JSON line each in `trials/<id>.events.jsonl` (mode `0600`), removed once the settled trial is written; a failed removal is logged, never a failed run.
- Refuse a directory that already holds `execution.json` or `report.json`; the default directory is `.eval-results/runs/<run id>`.
- Keep the exit codes: the command's own (2 for a failed blocking gate, a recorded failure or a comparison issue), 1 after a typed failure printed as `code: message`, 130 after SIGINT or SIGTERM.
- `inspect` and `compare` never load the app configuration; loading one (all `list`, `validate` and `estimate` do) must open no clients.
- A count flag (`--repetitions`, `--concurrency`, `--timeout-ms`) goes through `positiveInt`, and `--budget-usd` (run and calibrate: the run's `spendBudget`) through `positiveAmount`: a bad value is `invalid`, never a silent default; `--flag=value` reads as `--flag value`.
- A list flag (`--task`, `--candidate`, `--grader`, `--exporter`) is read with `list`: every occurrence, split at commas, each value once in first-seen order. Every other flag a built-in command reads is in `SINGLE_VALUED_FLAGS`, checked by `singleValued` before the command reads anything: given twice with different values, it is `invalid`, never its first value. An app command reads its own arguments; only `--config`, which loads the app, is checked for it.
- A run's summary (its output, `inspect --summary`) adds `skipped` and `spend` only when the run recorded spend.
- Read files through `readJson`, and a run file through `readRun`: a missing file is `missing`, one that does not decode `invalid`, any other failure `persistence`. `readRun` reads a file of no more bytes than the longest string whole; a larger one in parts (`readRunInParts`: the run without its trials, then each trial, cut at the bounds `JSON.stringify(run, null, 2)` gives them: a line break there stands only between tokens), or whole, as before, when it is in any other layout.
- An `EvaluationError` that wraps a failure keeps it as `cause` and says what failed (`Cannot read <path>: EISDIR: …`, `Run <id> does not encode: …`), the reason from `reasonOf(Cause.die(error))` or a schema error's `message`, never `String(error)`.
- App `commands` are dispatched before the built-in commands other than `help`, `inspect` and `compare`.
- A command that loads the app is one `eval.cli` span carrying `eval.command`, opened inside the app's `observability` layer, which closes with the command (an interrupted one too) and so flushes its spans. Open no span outside that layer: its children would point at a parent the app's tracer never receives. `help`, `inspect` and `compare` load no app and open no span; `evaluationCli` and `writeJson` are `Effect.fnUntraced`.
- Name test support `*.testing.ts`: the build leaves those files out.

## Public surface

- `evaluationCli(args, options?)`: the whole command line as an `Effect` of its exit code (`CliOptions`: `config`, `exporters`, `output`); `cliArguments` parses the arguments (`value`, `required`, `has`, `list`, `singleValued`, `ids`).
- `runCliMain(program, host?)` with `nodeProcess` (`CliProcess`): runs a command as the main fiber with signal handling, for an app's own entry point.
- `loadEvaluationApp(path, args)`: imports a configuration module (an `EvaluationApp`, or a function of the arguments returning one) and decodes its default export with `parseEvaluationApp`.
- `EvaluationRunStoreFsLive(directory)`: the file-backed `EvaluationRunStore` (`appendTranscript` writes the event lines; `writeRun` writes a run of any size); `fileIo`, `readText`, `readJson`, `readRun` (a run file of any size), `writeJson`.
- The `efferent-eval` bin (`src/main.ts`).

The root is the package's only entry: there are no subpaths, and every name a module publishes is the root's. It names each export, and `quality/exports-have-consumers` checks each one: the packed consumer (`scripts/evaluation-consumer.fixture.mjs`) imports `evaluationCli`, and the rest, which no first-party code imports, are tagged `@public` at their declarations.

## Model-facing text

None: the judges and their prompts belong to the app's graders.

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/main.ts` | the bin: `runCliMain(evaluationCli(argv))` |
| `src/cli.adapter.ts` | argument parsing and every command |
| `src/run-main.adapter.ts` | `runCliMain`: main fiber, stop signals, exit code |
| `src/config-loader.adapter.ts` | `loadEvaluationApp` through `tsx`'s `tsImport` |
| `src/adapters/evaluation-store.fs.adapter.ts` | the file-backed run store, JSON reads and writes, and run files written and read in parts |
| `src/cli-fixture.testing.ts`, `src/hanging-run.testing.ts` | test apps: one in-memory function (it may record events); one trial that records two events and never ends |
| `src/index.ts` | the public exports |

## Tests

- `src/cli.test.ts`: the commands over `cliFixture` in a temporary directory (runs and a calibration under and over `--budget-usd`, export failure, the `eval.cli` span tree in the app's `observability` layer and its release after the spans end, an interrupted run's too, grading revisions, comparison, flags (repeated list flags merged, conflicting single-valued ones refused), file errors, a running trial's event file and its removal, the causes and messages of wrapped failures); `validate` on `node` (tsx's loader does not run on Bun) refuses configurations whose default export is not an app.
- `src/adapters/evaluation-store.fs.adapter.test.ts`: run files over every release's recorded run and runs whose strings look like the bounds: the bytes of `JSON.stringify(run, null, 2)` (mode `0600`, no temporary left), written a few characters at a time too; read back in parts under a small limit at any chunk size; another layout, a damaged, cut or missing file, a failed write.
- `src/run-main.adapter.test.ts`: signals and exit codes over a fake `CliProcess`; `hangingRun` spawns `node` on `src/main.ts` with `hanging-run.testing.ts`, then sends SIGINT (the trial settles as `cancelled` with its events) or SIGKILL (the event file is left beside the running trial) (needs `node` on `PATH`); a `run` with repeated `--task` flags through `runCliMain` runs exactly the selected tasks, and conflicting `--directory` values exit 1.
- `bun run verify:packages` runs `scripts/evaluation-consumer.fixture.mjs` on Node: `evaluationCli` from the packed package loads a TypeScript configuration and runs a suite.
- Run: `bun test packages/evals-cli`.

See the root AGENTS.md for the enforced rules and the definition of done.
