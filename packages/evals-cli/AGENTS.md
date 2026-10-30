# @xandreed/evals-cli

The `efferent-eval` command line over `@xandreed/evals`: it loads an app's `eval.config.ts` through `tsx`, runs, calibrates, grades, inspects, compares, reviews and exports, and keeps every result as JSON files on disk. Node 24 (the declared engine; the bin is `src/main.ts`, and the tests run on Bun); layer `evals-cli` in `foundry.config.ts` (imports `@xandreed/evals`, `node:` and `tsx/esm/api` only).

## Rules

- Local files are the result: a run writes `report.json` (`execution.json` with `--execute-only`) and `trials/*.json`; a failed export after it is only a line in `export-receipts.json`.
- Write JSON through `writeJson` (a temporary file renamed into place, mode `0600`, the temporary removed on failure), never in place. The one append: a running trial's transcript events, one JSON line each in `trials/<id>.events.jsonl` (mode `0600`), removed once the settled trial is written; a failed removal is logged, never a failed run.
- Refuse a directory that already holds `execution.json` or `report.json`; the default directory is `.eval-results/runs/<run id>`.
- Keep the exit codes: the command's own (2 for a failed blocking gate, a recorded failure or a comparison issue), 1 after a typed failure printed as `code: message`, 130 after SIGINT or SIGTERM.
- `inspect` and `compare` never load the app configuration; loading one (all `list`, `validate` and `estimate` do) must open no clients.
- A count flag (`--repetitions`, `--concurrency`, `--timeout-ms`) goes through `positiveInt`: a bad value is `invalid`, never a silent default; `--flag=value` reads as `--flag value`.
- Read files through `readJson`: a missing file is `missing`, one that does not decode `invalid`, any other failure `persistence`.
- An `EvaluationError` that wraps a failure keeps it as `cause` and says what failed (`Cannot read <path>: EISDIR: …`, `Run <id> does not encode: …`), the reason from `reasonOf(Cause.die(error))` or a schema error's `message`, never `String(error)`.
- App `commands` are dispatched before the built-in commands other than `help`, `inspect` and `compare`.
- A command that loads the app is one `eval.cli` span carrying `eval.command`, opened inside the app's `observability` layer, which closes with the command (an interrupted one too) and so flushes its spans. Open no span outside that layer: its children would point at a parent the app's tracer never receives. `help`, `inspect` and `compare` load no app and open no span; `evaluationCli` and `writeJson` are `Effect.fnUntraced`.
- Name test support `*.testing.ts`: the build leaves those files out.

## Public surface

- `evaluationCli(args, options?)`: the whole command line as an `Effect` of its exit code (`CliOptions`: `config`, `exporters`, `output`); `cliArguments` parses the arguments.
- `runCliMain(program, host?)` with `nodeProcess` (`CliProcess`): runs a command as the main fiber with signal handling, for an app's own entry point.
- `loadEvaluationApp(path, args)`: imports a configuration module (an `EvaluationApp`, or a function of the arguments returning one) and decodes its default export with `parseEvaluationApp`.
- `EvaluationRunStoreFsLive(directory)`: the file-backed `EvaluationRunStore` (`appendTranscript` writes the event lines); `fileIo`, `readText`, `readJson`, `readRun`, `writeJson`.
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
| `src/adapters/evaluation-store.fs.adapter.ts` | the file-backed run store and JSON reads and writes |
| `src/cli-fixture.testing.ts`, `src/hanging-run.testing.ts` | test apps: one in-memory function (it may record events); one trial that records two events and never ends |
| `src/index.ts` | the public exports |

## Tests

- `src/cli.test.ts`: the commands over `cliFixture` in a temporary directory (export failure, the `eval.cli` span tree in the app's `observability` layer and its release after the spans end, an interrupted run's too, grading revisions, comparison, flags, file errors, a running trial's event file and its removal, the causes and messages of wrapped failures); `validate` on `node` (tsx's loader does not run on Bun) refuses configurations whose default export is not an app.
- `src/run-main.adapter.test.ts`: signals and exit codes over a fake `CliProcess`; `hangingRun` spawns `node` on `src/main.ts` with `hanging-run.testing.ts`, then sends SIGINT (the trial settles as `cancelled` with its events) or SIGKILL (the event file is left beside the running trial) (needs `node` on `PATH`).
- `bun run verify:packages` runs `scripts/evaluation-consumer.fixture.mjs` on Node: `evaluationCli` from the packed package loads a TypeScript configuration and runs a suite.
- Run: `bun test packages/evals-cli`.

See the root AGENTS.md for the enforced rules and the definition of done.
