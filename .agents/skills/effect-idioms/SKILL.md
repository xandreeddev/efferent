---
name: effect-idioms
description: Effect 4.0.7 idioms this repo requires beyond what the gates catch — v3 to v4 names, Schema at every edge, Option and Result, errors vs defects (tagged errors with a cause, harnessCodeOf, isHarnessError, TurnError, reasonOf), bounded concurrency, scopes and timeouts, Clock and Random, Config and Redacted, Effect.fn spans at service boundaries, Match over _tag checks. Read before writing Effect code here, or when tsc rejects an Effect 3 name.
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
  `Schema.TaggedError` with a `reason` literal (`BashError`), or a
  `HarnessError { code, message, cause? }` at framework boundaries
  (`config.options`, `plugin.activation`). Build a first-party one with
  `harnessError(code, message, cause)`, which takes only a `HarnessCode`,
  one of `HARNESS_CODES` (`new HarnessError({ code, plugin, message, cause })`
  when it names the plugin). That list is published: a new code joins it,
  with its meaning in `ERROR_CODES` (`scripts/generate-event-reference.ts`;
  `docs:generate` fails on a raised code the list lacks), and a listed code
  is never renamed or removed.
- A case a caller handles on its own is its own tag, raised where it
  happens; never map a code to a tag at a boundary. `Agent.turn` (any
  `TurnRunner`) fails with a `TurnBeginError` (`SessionBusy`,
  `NotResumable`, … `SessionContended`: nothing was opened) or a
  `TurnError`, the failure of a turn's own writes and of every port on the
  turn's path (`TurnClosed`, `ReservedKind`, `SessionContended`,
  `SessionLogError`, else a `HarnessError`). `SessionLogError` is storage
  only: the store unreachable or busy, its data unreadable or unstorable.
- A bug or a broken invariant is a defect (`Effect.die`; `Effect.orDie` only
  where failure is impossible by construction), and so is a failure to
  encode a value of your own. Turn defects into errors only where something
  reports them (`definePlugin` maps them to `plugin.defect`).
- Match errors by tag and fields, whichever copy of core made them:
  `Effect.catchTag("TurnClosed", …)`, `Effect.catchIf(isHarnessError, …)`,
  `isTurnError`, `Predicate.isTagged(e, "X")`. Never `instanceof` or
  `Schema.is(X)` of the error class: both check the class, and a host may
  load two copies of core.
- A failure's code is `harnessCodeOf(e)`: a `HarnessError`'s own, the one
  a tag stands for (`turnBeginCodes`, `TAGGED_CODES`: `SessionBusy` is
  `session.busy`), or a tagged error's string `code`. A Node or SQLite
  error's `code` (`ENOENT`) is `errorCodeOf(e)` (the evals packages export
  their own), never `"code" in e` (`effect/no-code-property-guard`). Compare a `code` to a
  literal only in the module that declares the error; elsewhere use a guard
  it exports (`isStoreBusy`; `effect/no-error-code-compare`).
- A tagged error keeps the failure it wraps as a value, in a `cause` field
  (`Schema.optional(Schema.Defect())`), and says what failed; not
  `message: String(e)` (`effect/no-stringified-cause`).
- Text from a cause is `reasonOf(cause)` (`@xandreed/core`) for anything
  stored, reported or shown to the model; it reads messages only, so a
  `cause` never puts a stack there. `Cause.pretty` only inside a log call,
  `Effect.logError("what failed", cause)`, never in data: it carries stack
  frames and host paths.
- Never swallow: `Effect.ignore({ log: "Warn", message: "…" })` (`"Debug"`
  for an expected miss), not a bare `Effect.ignore`,
  `Effect.catch(() => Effect.void)` or an `Effect.orElseSucceed` that no
  logging `Effect.tapError` precedes (`effect/no-silent-ignore`).
- Tool handlers return `Failure` data (`failureMode: "return"`); skill
  `write-model-text`.

## 5. Concurrency, scopes, time bounds

- Always state `concurrency` on `Effect.forEach` and `Effect.all`: `1` when
  order, a shared resource or the first failure matters (writes to one log,
  ordered events, decoding that reports the first bad item); a number, or a
  config option (`digestConcurrency`), for independent I/O; `"unbounded"`
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
  in R (`Effect<A, E, SessionLog>`, `never` for none) or keep R a type
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
  conformance kits and their fakes; runtime activation; and everything on
  the path between `traceTurn` and `guardTurn` (no span may sit between
  them).
- **Names**: dotted lowercase with snake_case words. `agent.turn`,
  `engine.`, `tool.`, `providers.` and `LanguageModel.` belong to the spans
  that use them today (the sdk tests select `tool.*` spans by prefix): no
  new name starts with them.
- **Ids**: span attributes and log annotations share their keys:
  `efferent.session.id`, `efferent.run.id`, `efferent.turn` (core's
  `sessionAttributes` and `turnAttributes`), `efferent.task.id`,
  `llm.model`, `eval.run.id`, `eval.trial.id`. A log message names no id.
- **Annotations go in pipeables**:
  `Effect.fn("sessions.begin")(function* (address, input) { … }, (effect, address) => Effect.annotateLogs(effect, sessionAttributes(address.id)))`.
  The pipeables run inside the new span, so `annotateCurrentSpan` there
  annotates it. Converting a function that annotates its caller's span
  moves those attributes onto the new span: check what reads them.
- `Effect.withSpan` where `Effect.fn` does not fit: an Effect value (a
  writer's `flush`), or a generic internal helper.

| Area | Spans |
|---|---|
| sdk, core | `agent.turn.begin`, `agent.turn`, `turn.persist_reply`, `skills.collect`, `plugin.activate`, the in-memory log's `session_log.<op>` |
| plugin-sessions | `sessions.<op>` (each `Sessions` call but `changes`), `turn_writer.commit`, `turn_writer.flush`, `turn_writer.end` |
| plugin-session-sqlite | `session_log.open`, `session_log.<create\|head\|list\|read\|commit\|remove>` |
| plugin-models | `providers.generate` (around `models.credentials`, the build and the request), `models.utility` |
| memory plugins | `memory.open`, `memory.summarize`, `memory.digest` |
| plugin-tasks | `tasks.<op>`, `task.run` |
| plugin-workspace | `bash.exec`, `skills.settle` |
| plugin-render | `render.emit` |
| evals | `eval.run`, `eval.trial`, `eval.grade`, `eval.regrade`, `eval.calibrate`, `eval.calibration.execute`, `eval.calibration.project`, `eval.pairwise`, `eval.retrieval.assess`, `eval.semantic.run`, `eval.semantic.llm`, `eval.semantic.jev`, `eval.evaluator` |
| evals exporters, evals-cli | `eval.export`, `eval.cli` |
| foundry | `foundry.check`, `foundry.run`, `foundry.attempt`, `foundry.pipeline`, `foundry.gate` |

## 8. Branching

- A `_tag` union: `Match.valueTags(value, { … })` or
  `Match.value(x).pipe(Match.tag(…), Match.exhaustive)`; `Option.match`,
  `Result.match`, `Exit.match`. Not `switch (x._tag)`, an if/else ladder,
  adjacent `if (x._tag === …) return …` statements or a ternary chain on
  `_tag`, `type`, `role` or `mode` (`effect/match-over-tag-switch`;
  `Match.discriminators("type")` for a field other than `_tag`;
  `Match.orElse` where a default is deliberate).
- No `let`, no loops, no `try`/`catch`/`throw`: the gates refuse them.

## Checklist

- [ ] Every Effect name checked against 4.0.7
- [ ] Outside data decoded with a schema, effectfully; nothing cast
- [ ] `Option` for absence, `Result` for pure failure
- [ ] Typed errors for expected failures; `reasonOf` for cause text; nothing swallowed silently
- [ ] `concurrency` stated; waits bounded; resources scoped
- [ ] `Clock`, `Random`, `Config`, `Redacted` instead of ambient globals
- [ ] `Effect.fn("area.op")` at service boundaries, `fnUntraced` for hot helpers
- [ ] `Match` for unions
