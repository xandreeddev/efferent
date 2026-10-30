---
name: add-port
description: Add or change a service port (Context.Service), its adapters and its conformance kit in efferent — placement, R = never, results vs errors, stable service keys, the kit and its careless-stub self-test, one foreign-error mapping per adapter. Read before creating a *.port.ts, a *Live layer or a *.conformance.ts file, or changing what a port method promises.
---

# Add or change a port

A port is a contract in domain terms; adapters are interchangeable
implementations proved by one runnable kit. Worked example: `Bash`
(`packages/core/src/ports/bash.port.ts`, `core/src/domain/bash.entity.ts`,
`core/src/workspace/bash.conformance.ts`, `plugin-workspace/src/bash.adapter.ts`).

## 1. Place the contract

- Shared by several packages: `packages/core/src/ports/<thing>.port.ts`.
- Owned by one package (even if the host implements it, like
  `plugin-models/src/ports/host-credentials.port.ts`):
  `packages/<pkg>/src/ports/<thing>.port.ts`.
- A `Context.Service` anywhere else fails `architecture/context-tags-live-in-ports`.
- Data, options and errors go in `<thing>.entity.ts`; pure helpers in
  `<thing>.entity.functions.ts` (`collectBashResult`). Skill `domain-entity`.

## 2. Write the service

```ts
/**
 * <What it does, in domain terms.> <Which outcomes are results the caller
 * reads, and which are errors.> `thingConformance` is the contract as runnable checks.
 */
export class Thing extends Context.Service<Thing, {
  /** <one line per method> */
  readonly doIt: (input: ThingInput) => Effect.Effect<ThingResult, ThingError>
}>()("@xandreed/core/Thing") {}
```

- Name intents (`Bash.exec`, `FileSystem.list`), never a provider or SDK.
  Give it the fewest methods its callers need.
- Methods return `Effect` or `Stream` with `R = never`. Only a callback
  pass-through carries the caller's `R` (`Sessions.drain`).
- Expected failures: a `Schema.TaggedError` with a `reason` literal
  (`BashError { reason, message }`). Absence: `Option`. Outcomes the caller
  reads (a non-zero exit, a timeout) are results, not errors. The doc
  comment says which, as `bash.port.ts` does.
- Key: a new port uses `@xandreed/<package>/<Name>` (`@xandreed/core/Bash`,
  the form the newest ports use; older keys start with `efferent/`). NEVER
  rename an existing key: keys
  appear in plugins' `provides`/`requires`, `docs/plugin-reference.json` and
  hosts' `bindings`. A port that moves to another package keeps its key
  (`AuthStore`, now in plugin-models, is still `@xandreed/core/AuthStore`). A rename is a CHANGELOG **Breaking** entry with a
  migration note.
- Implement methods with `Effect.fn("<thing>.<method>")` so each call is a
  named span (skill `effect-idioms`).

## 3. Write the kit

- `<thing>.conformance.ts` exporting
  `thingConformance(subject): ReadonlyArray<ConformanceCheck>`; the subject
  opens a fresh instance per check (`BashSubject.open`). In core, build checks
  with `check`, `expect`, `fail`, `freshId` and `eventually` from
  `packages/core/src/conformance.functions.ts`; checks fail with
  `ConformanceFailure` (`@xandreed/core/conformance`, which exports `check`
  too, for a kit outside core).
- Export the kit from the package's entry, core's from
  `src/conformance/index.ts` (`@xandreed/core/conformance`): kits ship, so
  hosts can prove their own adapters. Never import a module whose name ends in `testing.ts` from a kit:
  the build drops those files.
- A contract change starts as a new or changed check in the kit.
- Self-test it with careless stubs: fakes that must fail every check, plus a
  test that the check ids are the documented list
  (`core/src/workspace/bash.conformance.test.ts`). A kit that a do-nothing
  adapter passes proves nothing.

## 4. Write adapters

- `<thing>.<variant>.adapter.ts` exporting `Thing<Variant>Live`
  (`core/src/workspace/file-system.memory.adapter.ts` exports
  `FileSystemMemoryLive`; `plugin-workspace/src/bash.adapter.ts` exports
  `BashLive`). An in-memory adapter with no IO may live in core; IO adapters
  live in a plugin.
- Foreign promises only through `Effect.tryPromise`. Map foreign error codes
  to the port's reason in ONE function (`fsReasonOf`,
  `plugin-workspace/src/local-system.entity.functions.ts`). No foreign class,
  provider type or `unknown` leaves the adapter.
- `as never` only in a file listed in `ERASURE_BOUNDARY` in
  `foundry.config.ts`; adding a file there needs its reason in the PR.

## 5. Prove and ship

1. Run the kit over every adapter in that adapter's package tests
   (`plugin-workspace/src/bash.adapter.test.ts` maps `bashConformance(subject)`
   to one `test` per check).
2. Run it on Node over the packed package in `scripts/verify-packages.ts`
   (as for `bashConformance` and `fileSystemConformance`), then
   `bun run build:packages && bun run verify:packages`.
3. The providing plugin lists the class in `provides`; consumers in
   `requires`, or in `optional` read with `Effect.serviceOption`.
4. `bun run docs:generate` (the plugin reference lists keys), CHANGELOG
   entry, `bun run typecheck`, `env -u HTTP_PROXY -u HTTPS_PROXY bun test`.

## Checklist

- [ ] Contract in a `.port.ts`; the doc comment states results vs errors
- [ ] Schemas and errors in the entity file; `R = never`; `Option` for absence
- [ ] New key `@xandreed/<package>/<Name>`; no existing key renamed
- [ ] Methods are `Effect.fn("<thing>.<method>")`
- [ ] Kit exported from its entry (core: `src/conformance/index.ts`) and self-tested against careless stubs
- [ ] Every adapter runs the kit on Bun and, packed, on Node
- [ ] One foreign-error mapping per adapter; no provider types escape
- [ ] docs:generate, CHANGELOG, typecheck, tests
