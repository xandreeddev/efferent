# @xandreed/evals-cli

The `efferent-eval` command line over `@xandreed/evals`: it loads an app's `eval.config.ts` through `tsx`, runs, calibrates, grades, inspects, compares, reviews and exports, and keeps every result as JSON files on disk. Node 24 (the declared engine; the bin is `src/main.ts`, and the tests run on Bun); layer `evals-cli` in `foundry.config.ts` (imports `@xandreed/evals`, `node:` and `tsx/esm/api` only).

## Rules

- Local files are the result: a run writes `report.json` (`execution.json` with `--execute-only`) and `trials/*.json`; a failed export after it is only a line in `export-receipts.json`.
- Write JSON through `writeJson` (a temporary file renamed into place, mode `0600`, the temporary removed on failure), never in place. JSON files, including run and individual trial files, hold the exact `JSON.stringify(value, null, 2)` bytes of the encoded value, emitted through bounded text buffers, including within strings. No complete run or trial text is allocated. Native `toJSON`, key ordering, omissions and scalar encoding are preserved; decoded scalar strings and the full object graph must still fit in memory. The one append: a running trial's transcript events, bounded compact JSON pieces forming one JSON line each in `trials/<id>.events.jsonl` (mode `0600`), removed once the settled trial is written; a failed removal is logged, never a failed run. The runner serializes records per trial; direct store event appends also share a process-local lock by resolved filename, across store instances. Each logical event append finishes before ordinary interruption, and an encoding or write failure truncates back to the previous prefix. Separate processes must use separate result directories. A process kill can still leave incomplete crash evidence.
- Refuse a directory that already holds `execution.json` or `report.json`; the default directory is `.eval-results/runs/<run id>`.
- Keep the exit codes: the command's own (2 for a failed blocking gate, a recorded failure or a comparison issue), 1 after a typed failure printed as `code: message`, 130 after SIGINT or SIGTERM.
- `inspect` and `compare` never load the app configuration; loading one (all `list`, `validate` and `estimate` do) must open no clients.
- A count flag (`--repetitions`, `--concurrency`, `--timeout-ms`) goes through `positiveInt`, and `--budget-usd` (run and calibrate: the run's `spendBudget`) through `positiveAmount`: a bad value is `invalid`, never a silent default; `--flag=value` reads as `--flag value`.
- A list flag (`--task`, `--candidate`, `--grader`, `--exporter`) is read with `list`: every occurrence, split at commas, each value once in first-seen order. Every other flag a built-in command reads is in `SINGLE_VALUED_FLAGS`, checked by `singleValued` before the command reads anything: given twice with different values, it is `invalid`, never its first value. An app command reads its own arguments; only `--config`, which loads the app, is checked for it.
- A run's summary (its output, `inspect --summary`) adds `skipped` and `spend` only when the run recorded spend.
- Read files through `readJson`, and a run file through `readRun`: a missing file is `missing`, one that does not decode `invalid`, any other failure `persistence`. `readJson` and `readRun` parse bounded UTF-8 chunks in any valid JSON layout, without a whole-file or whole-trial text allocation. They retain strict JSON grammar, native numeric conversion, duplicate-key behavior and own `__proto__` properties; invalid UTF-8 is replaced as with Node's `readFile` decoding. A decoded scalar and the resulting object graph still occupy memory.
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
| `src/adapters/evaluation-store.fs.adapter.ts` | the file-backed run store, atomic JSON writes, bounded UTF-8 reads and event appends |
| `src/adapters/bounded-json.adapter.ts` | bounded JSON encoding and strict incremental parsing; no public entry exports |
| `src/cli-fixture.testing.ts`, `src/hanging-run.testing.ts` | test apps: one in-memory function (it may record events); one trial that records two events and never ends |
| `src/index.ts` | the public exports |

## Tests

- `src/cli.test.ts`: the commands over `cliFixture` in a temporary directory (runs and a calibration under and over `--budget-usd`, export failure, the `eval.cli` span tree in the app's `observability` layer and its release after the spans end, an interrupted run's too, grading revisions, comparison, flags (repeated list flags merged, conflicting single-valued ones refused), file errors, a running trial's event file and its removal, the causes and messages of wrapped failures); `validate` on `node` (tsx's loader does not run on Bun) refuses configurations whose default export is not an app.
- `src/adapters/evaluation-store.fs.adapter.test.ts`: every release's recorded runs and adversarial string contents: exact native pretty bytes (mode `0600`, no temporary left), small text buffers and byte chunks, alternate layouts, damaged/cut/missing files and failed atomic writes.
- `src/adapters/bounded-json.adapter.test.ts`: generated native-codec equivalence, long escaped strings and keys under instrumented native codec/sink limits, Unicode/escape boundaries, native `toJSON` and boxed-value semantics, strict malformed JSON, duplicate keys and prototype safety.
- `src/run-main.adapter.test.ts`: signals and exit codes over a fake `CliProcess`; `hangingRun` spawns `node` on `src/main.ts` with `hanging-run.testing.ts`, then sends SIGINT (the trial settles as `cancelled` with its events) or SIGKILL (the event file is left beside the running trial) (needs `node` on `PATH`); a `run` with repeated `--task` flags through `runCliMain` runs exactly the selected tasks, and conflicting `--directory` values exit 1.
- `bun run verify:packages` runs `scripts/evaluation-consumer.fixture.mjs` on Node: `evaluationCli` from the packed package loads a TypeScript configuration and runs a suite.
- Run: `bun test packages/evals-cli`.

See the root AGENTS.md for the enforced rules and the definition of done.
