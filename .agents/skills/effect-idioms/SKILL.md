---
name: effect-idioms
description: Effect 4.0.7 idioms this repo requires beyond what the gates catch — v3 to v4 names, Schema at every edge, Option and Result, errors vs defects (tagged errors, isHarnessError, reasonOf), bounded concurrency, scopes and timeouts, Clock and Random, Config and Redacted, Effect.fn spans at service boundaries, Match over _tag checks. Read before writing Effect code here, or when tsc rejects an Effect 3 name.
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
  only where a foreign API or the wire needs it.
- A pure computation that can fail returns `Result`; lift it with `Effect.fromResult`.

## 4. Errors and defects

- An expected failure the caller handles is a typed error: a
  `Schema.TaggedError` with a `reason` literal (`BashError`), or a
  `HarnessError { code, message }` at framework boundaries (`config.options`,
  `session.log`).
- A bug or a broken invariant is a defect (`Effect.die`; `Effect.orDie` only
  where failure is impossible by construction). Turn defects into errors
  only where something reports them (`definePlugin` maps them to `plugin.defect`).
- Match errors by tag or shape: `Effect.catchTag`, `Effect.catchIf(isHarnessError, …)`,
  `Schema.is(X)`. Never `instanceof`: a host may load two copies of core.
- Text from a cause is `reasonOf(cause)` (`@xandreed/core`) for anything
  stored, reported or shown to the model. `Cause.pretty` only inside a log
  call, `Effect.logError("what failed", cause)`, never in data: it carries
  stack frames and host paths.
- Never swallow: `Effect.ignore({ log: "Warn", message: "…" })`, not a bare
  `Effect.ignore` or `Effect.catch(() => Effect.void)`.
- Tool handlers return `Failure` data (`failureMode: "return"`); skill
  `write-model-text`.

## 5. Concurrency, scopes, time bounds

- Always state `concurrency` on `Effect.forEach` and `Effect.all`: a number,
  or a config option (`digestConcurrency`). `"unbounded"` only in
  conformance kits. No `Promise.all`.
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

## 7. Spans and functions

- A service method or an exported effectful function at a service boundary
  is `Effect.fn("area.op")(function* (…) { … })`, named like the existing
  spans (`agent.turn`, `engine.run`): `bash.exec`, `sessions.begin`.
- A hot helper called per item, chunk or event is `Effect.fnUntraced`.
- Older code uses plain `Effect.gen` closures; convert a service when you
  change it, not in passing.
- Context for logs: `Effect.annotateLogs`; spans: `Effect.withSpan` where
  `Effect.fn` does not fit.

## 8. Branching

- A `_tag` union: `Match.valueTags(value, { … })` or
  `Match.value(x).pipe(Match.tag(…), Match.exhaustive)`; `Option.match`,
  `Result.match`, `Exit.match`. Not `switch (x._tag)` or an if/else ladder
  on `_tag` (`effect/match-over-tag-switch`).
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
