---
name: add-port
description: Add or change a service port (Context.Service) of the kernel, its adapters and its conformance kit in efferent — placement, R = never, results vs errors, stable service keys, the kit and its careless-stub self-test, one foreign-error mapping per adapter. Read before creating a *.port.ts, a plugin's layer or a *.conformance.ts file, or changing what a port method promises.
---

# Add or change a port

A port is a contract in domain terms; adapters are interchangeable
implementations proved by one runnable kit. Worked example: `Shell`
(`packages/sdk/src/contracts/shell/shell.port.ts`, its
`shell.entity.ts` and `shell.conformance.ts`; the scripted adapter
`plugins/shell-scripted/scripted-shell.adapter.ts`; the process adapter
`node/shell-process/process-shell.adapter.ts`, on the Node entry).

## 1. Place the contract

- What every agent has, whatever its workflow (the journal, sessions,
  events, the spend ledger): core's kernel, `packages/core/src`
  (ADR 0002). Anything else is a workflow contract of the sdk's kernel:
  a folder `packages/sdk/src/contracts/<name>/`.
- A `Context.Service` outside a `.port.ts` file or a `ports/` folder fails
  `architecture/context-tags-live-in-ports`.
- Data, options and errors go in `<thing>.entity.ts`; pure helpers in
  `<thing>.entity.functions.ts`. Skill `domain-entity`.
- A contract imports core's kernel and other contracts, never a plugin
  (skill `kernel-architecture`).

## 2. Write the service

```ts
/**
 * <What it does, in domain terms.> <Which outcomes are results the caller
 * reads, and which are errors.> `thingConformance` is the contract as runnable checks.
 *
 * @public
 */
export class Thing extends Context.Service<Thing, {
  /** <one line per method> */
  readonly doIt: (input: ThingInput) => Effect.Effect<ThingResult, ThingError>
}>()("@xandreed/sdk/kernel/Thing") {}
```

- Name intents (`Shell.run`, `Files.read`), never a provider or SDK. Give it
  the fewest methods its callers need.
- Methods return `Effect` or `Stream` with explicit requirements. Ordinary
  operations use `R = never`; caller-owned resources may require `Scope`.
- Expected failures: a `Schema.TaggedError` (`ShellRefused`,
  `ShellUnavailable`). Absence: `Option`. Outcomes the caller reads (a
  non-zero exit, a timeout) are results, not errors. The doc comment says
  which, as `shell.port.ts` does.
- Key: a new port uses `@xandreed/core/kernel/<Name>` or
  `@xandreed/sdk/kernel/<Name>`. NEVER rename an existing key: a port that
  moves keeps its key (`Memory`, now the sdk's, is still
  `@xandreed/core/kernel/Memory`). A rename is a CHANGELOG **Breaking**
  entry with a migration note.
- Implement methods with `Effect.fn("<thing>.<method>")` so each call is a
  named span (skill `effect-idioms`).

## 3. Write the kit

- `<thing>.conformance.ts` exporting
  `thingConformance(subject): ReadonlyArray<ConformanceCheck>`; the subject
  opens a fresh instance per check (`ShellSubject`). Build checks with the
  kernel's own helpers (`contracts/conformance.entity.functions.ts` in the
  sdk, `conformance.entity.functions.ts` in core's kernel); checks fail with
  `ConformanceFailure`, and a failure names the check it came from.
- Export the kit from the kernel's entry (`@xandreed/sdk`), so hosts
  can prove their own adapters. Never import a module whose name ends in
  `testing.ts` from a kit: the build drops those files.
- A contract change starts as a new or changed check in the kit.
- Self-test it with careless adapters: each fails the checks of what it is
  careless about and no others, and the check ids are the documented list
  (`node/shell-process/shell-kit.test.ts`, `kits.test.ts`). A kit that a
  do-nothing adapter passes proves nothing.

## 4. Write adapters

- A plugin is a layer in a `.adapter.ts` file, in a folder of its own: a
  browser-safe one under `plugins/<name>/` (`scriptedShell`), one that needs
  a runtime's modules under `node/<name>/` (`processShell`, ADR 0024). A new
  folder gets its boundaries layer in `foundry.config.ts`, its name in the
  entry's `canImport` and in `SDK_KERNEL_TESTS`.
- Foreign promises only through `Effect.tryPromise`. Map foreign error codes
  to the port's errors in ONE function. No foreign class, provider type or
  `unknown` leaves the adapter.
- No `as never`: fix the type.

## 5. Prove and ship

1. Run the kit over every adapter in that adapter's tests, one `test` per
   check.
2. Run it from the packed packages on Node and Bun in
   `scripts/kernel-consumer.fixture.mjs` (`bun run build:packages && bun run
   verify:packages`).
3. A host composes the layer; nothing declares what it provides.
4. CHANGELOG entry, `api/` (`bun run api:update`), `bun run typecheck`,
   `env -u HTTP_PROXY -u HTTPS_PROXY bun test`.

## Checklist

- [ ] Contract in a `.port.ts`; the doc comment states results vs errors
- [ ] Schemas and errors in the entity file; `R = never`; `Option` for absence
- [ ] New key under `@xandreed/core/kernel/` or `@xandreed/sdk/kernel/`; no existing key renamed
- [ ] Methods are `Effect.fn("<thing>.<method>")`
- [ ] Kit exported from the kernel's entry and self-tested against careless adapters
- [ ] Every adapter runs its kit, and the packed consumer runs it on Node and Bun
- [ ] One foreign-error mapping per adapter; no provider types escape
- [ ] CHANGELOG, `api/`, typecheck, tests
