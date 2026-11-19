---
name: effect-idioms
description: Effect 4.0.7 idioms this repo requires beyond what the gates catch — v3 to v4 names, Schema at every edge, Option and Result, errors vs defects (tagged errors with a reason and a cause, catchTag, defects that end a turn), bounded concurrency, scopes and timeouts, Clock and Random, Config and Redacted, Effect.fn spans at service boundaries, Match over _tag checks. Read before writing Effect code here, or when tsc rejects an Effect 3 name.
---

# Effect idioms for this repo

The repo pins `effect` 4.0.7. Check a name in `node_modules/effect/dist/*.d.ts`
before using it; do not trust Effect 3 memory.

## 1. Effect 3 names that do not exist here

| Effect 3 | Here |
|---|---|
| `Either` | `Result` (`Result.succeed`, `Result.fail`, `Result.match`); `Effect.result` instead of `Effect.either`; `Effect.fromResult` |
| `Effect.catchAll`, `catchAllCause`, `catchAllDefect` | `Effect.catch`, `Effect.catchCause`, `Effect.catchDefect`; also `catchTag`, `catchIf` |
| `Context.Tag`, `GenericTag` | `class X extends Context.Service<X, Shape>()("@xandreed/<package>/X") {}`; `Context.Reference` for a default-valued setting |
| `Effect.fork`, `forkDaemon` | `Effect.forkChild`, `Effect.forkScoped`, `Effect.forkDetach` |
| `Option.fromNullable` | `Option.fromNullishOr` |
| `Schema.decodeUnknown`, `Schema.parseJson` | `Schema.decodeUnknownEffect`, `Schema.fromJsonString(schema)` |
| `Schema.Literal("a", "b")`, `Schema.Union(A, B)` | `Schema.Literals(["a", "b"])`, `Schema.Union([A, B])` |
| `Schema.filter`, `Schema.pattern` | `.check(Schema.makeFilter(…))`, `Schema.isPattern`, `Schema.isBetween`, … |
| `@effect/platform`, `@effect/ai` | subpaths of `effect`: `effect/ai`, `effect/http`, `effect/socket`, `effect/observability`, `effect/testing` |
| `Effect.iterate` (never existed in v4) | `Effect.repeat({ while })`, `Effect.whileLoop`, `Effect.reduce`, array combinators, `Ref` |

## 2. Schema at every edge

- Anything from outside the process (JSON text, a file, an HTTP body, a
  stored event, a tool's input) is decoded, never cast:
  `Schema.decodeUnknownEffect(Schema.fromJsonString(Thing))(text)`. Not
  `JSON.parse` plus `as`.
- Encode before writing (`Schema.encodeEffect`). Decoding and encoding stay
  in the error channel: no `decodeSync`, `decodeUnknownSync` or `encodeSync`.
- A union or optional shape is a schema, not a hand-written type guard; check
  a value with `Schema.is(X)`.

## 3. Option and Result

- Absence is `Option`: never return `A | undefined` (`effect/no-nullable-return`).
  Convert at a foreign edge with `Option.fromNullishOr`; read with
  `Option.match` or `Option.getOrElse`. `Option.getOrUndefined`/`getOrNull`
  only in the adapter where a foreign API or the wire needs it
  (`effect/no-option-unwrap`).
- A pure computation that can fail returns `Result`; lift it with `Effect.fromResult`.

## 4. Errors and defects

- An expected failure the caller handles is a typed error: a
  `Schema.TaggedError` with a `reason` literal and words for the person who
  reads it (`SessionRefused { reason, message }`, `JournalStorageError`,
  `ShellRefused`). A case a caller handles on its own is its own reason or
  its own tag, raised where it happens; never map a message to a tag at a
  boundary.
- A bug or a broken invariant is a defect (`Effect.die`; `Effect.orDie` only
  where failure is impossible by construction), and so is a failure to
  encode a value of your own. A kernel tool's failed write is a defect of
  the call: `callTool` stores it as the call's failed result.
- Match errors by tag and fields, whichever copy of the kernel made them:
  `Effect.catchTag("SessionRefused", …)`, `Predicate.isTagged(e, "X")`.
  Never `instanceof` or `Schema.is(X)` of the error class: both check the
  class, and a host may load two copies of a package.
- A Node or SQLite error's `code` (`ENOENT`) is `errorCodeOf(e)` (the
  kernel's Node entry and the evals packages each keep one), never
  `"code" in e` (`effect/no-code-property-guard`). Compare a `code` to a
  literal only in the module that declares the error; elsewhere use a guard
  it exports (`effect/no-error-code-compare`).
- A tagged error keeps the failure it wraps as a value, in a `cause` field
  (`Schema.optional(Schema.Defect())`), and says what failed; not
  `message: String(e)` (`effect/no-stringified-cause`). No stack reaches a
  report or the model: `Cause.pretty` only inside a log call,
  `Effect.logError("what failed", cause)`, never in data: it carries stack
  frames and host paths.
- Never swallow: `Effect.ignore({ log: "Warn", message: "…" })` (`"Debug"`
  for an expected miss), not a bare `Effect.ignore`,
  `Effect.catch(() => Effect.void)` or an `Effect.orElseSucceed` that no
  logging `Effect.tapError` precedes (`effect/no-silent-ignore`).
- A tool's expected failure is data the model reads (`failureMode:
  "return"`, a `failure` schema); skill `write-model-text`.

## 5. Concurrency, scopes, time bounds

- Always state `concurrency` on `Effect.forEach` and `Effect.all`: `1` when
  order, a shared resource or the first failure matters (writes to one log,
  ordered events, decoding that reports the first bad item); a number, or a
  config option, for independent I/O; `"unbounded"`
  only in conformance kits (`effect/require-concurrency-option`). No
  `Promise.all`.
- Give `Stream.callback` a `bufferSize`.
- Every wait on something outside the process has a bound:
  `Effect.timeoutOrElse({ duration, orElse })`.
- Resources: `Effect.acquireRelease` under `Effect.scoped` or a layer; work
  that outlives a call is `Effect.forkScoped` in the owner's scope.

## 6. Ambient state

- Time from `Clock.currentTimeMillis`, randomness from `Random.next` /
  `Random.nextIntBetween`; not `Date.now()`, `new Date()` or `Math.random()`.
  Tests use `TestClock` from `effect/testing`. A UUID is
  `Effect.sync(() => crypto.randomUUID())` in an adapter or kit (`freshId`).
- Environment through `Config` (`Config.String`, `Config.option`,
  `Config.Redacted`), so tests provide `ConfigProvider.fromEnv({ env })`.
  No `process.env` in package code; only a `main.ts` edge reads it.
- Secrets stay `Redacted` (`Schema.Redacted(Schema.String)` in a config)
  until the one call that sends them unwraps with `Redacted.value`.
- What an effect reads from its context is in its type: name the services
  in R (`Effect<A, E, Sessions>`, `never` for none) or keep R a type
  parameter. Never `unknown`: a service nothing provides then compiles and
  fails mid-run (`effect/no-unknown-requirements`).

## 7. Spans and functions

`effect/prefer-effect-fn` runs in every package: an exported function or a
service method that only returns `Effect.gen(…)` is one of the two below.

- **`Effect.fn("area.op")(function* (…) { … })`**: a port adapter's method,
  or an exported function that does work through a port (a store, a model,
  a process, a file tree, the network), run at most once per command, turn,
  step, tool call, commit or trial.
- **`Effect.fnUntraced`**: everything else. Pure functions in
  `*.entity.functions.ts` and decoders; constructors that run when a layer
  is built (`make*`); helpers run once per event, part, chunk or path;
  conformance kits and their fakes.
- **Names**: dotted lowercase with snake_case words. The kernel's spans are
  `<part>.<op>`, the part its contract, plugin or port, with no `kernel.`
  prefix (ADR 0030); `LanguageModel.` belongs to Effect AI's own spans of a
  model call, which the kernel never doubles. Kernel metrics and attributes
  are `efferent.*`, or OpenTelemetry's `gen_ai.*`.
- **Ids**: span attributes and log annotations share their keys, the
  kernel's in `contracts/turn/telemetry.entity.ts` (`efferent.session.id`,
  `efferent.turn`, `efferent.outcome`), the evals' `eval.run.id` and
  `eval.trial.id`. A log message names no id.
- **Annotations go in pipeables**:
  `Effect.fn("session.turn")(function* (id, body) { … }, (effect, id) => Effect.annotateLogs(effect, { "efferent.session.id": id }))`.
  The pipeables run inside the new span, so `annotateCurrentSpan` there
  annotates it. Converting a function that annotates its caller's span
  moves those attributes onto the new span: check what reads them.
- `Effect.withSpan` where `Effect.fn` does not fit: an Effect value (a
  writer's `flush`), or a generic internal helper.

| Area | Spans |
|---|---|
| evals | `eval.run`, `eval.trial`, `eval.grade`, `eval.regrade`, `eval.calibrate`, `eval.calibration.execute`, `eval.calibration.project`, `eval.retrieval.assess`, `eval.semantic.run`, `eval.semantic.llm`, `eval.semantic.jev`, `eval.evaluator` |
| evals exporters, evals-cli | `eval.export`, `eval.cli` |
| foundry | `foundry.check`, `foundry.run`, `foundry.attempt`, `foundry.pipeline`, `foundry.gate` |
| sdk kernel (ADR 0030) | `session.turn`, `session.begin`, `session.end`, `session.recover`, `session.fork`, `session.recover_turns`, `tool.call` (and the event `model.attempt`), `flat_memory.context`, `window_memory.context`, `summary_memory.context`, `inbox.enqueue`, `tasks.start`, `approval.approve`, `approval.approve_in`, `read_result.read`, `knowledge.curate`, `knowledge.curate_again`, `scripted_model.make`, `scripted_shell.make`; the Node entry's `journal_directory.<op>`, `journal_sqlite.<op>`, `disk_files.<op>`, `files_search.find`, `process_shell.run`, `openai_compatible_embedder.embed`, `in_memory_media.<op>`, `directory_media.<op>` |

## 8. Branching

- A `_tag` union: `Match.valueTags(value, { … })` or
  `Match.value(x).pipe(Match.tag(…), Match.exhaustive)`; `Option.match`,
  `Result.match`, `Exit.match`. Not `switch (x._tag)`, an if/else ladder,
  adjacent `if (x._tag === …) return …` statements or a ternary chain on
  `_tag`, `type`, `role` or `mode` (`effect/match-over-tag-switch`;
  `Match.discriminators("type")` for a field other than `_tag`;
  `Match.orElse` where a default is deliberate).
- Confined local builders may use mutation and loops without mutating inputs or
  leaking mutable state. Use `Ref` for shared state. No `try`/`catch`/`throw`.

## Checklist

- [ ] Every Effect name checked against 4.0.7
- [ ] Outside data decoded with a schema, effectfully; nothing cast
- [ ] `Option` for absence, `Result` for pure failure
- [ ] Typed errors for expected failures, the wrapped failure kept as a `cause`; nothing swallowed silently
- [ ] `concurrency` stated; waits bounded; resources scoped
- [ ] `Clock`, `Random`, `Config`, `Redacted` instead of ambient globals
- [ ] `Effect.fn("area.op")` at service boundaries, `fnUntraced` for hot helpers
- [ ] `Match` for unions
