---
name: domain-entity
description: Model domain data in efferent — entity/functions file pairs, Schema.Struct vs Schema.Class, tagged unions instead of boolean flags, invariants in the schema, branded ids, how absence is encoded on the wire (OptionFromNullOr vs optionalKey), and an aggregate's state as one tagged phase with pure transitions. Read before creating or changing a *.entity.ts or *.entity.functions.ts, a stored payload, a config schema or an adapter's state machine.
---

# Model domain data

Data is a schema; behaviour is a function over the schema's type. The gates
see a file by its suffix, so the suffix decides which rules apply.

## 1. Files come in pairs

- `<thing>.entity.ts`: schemas, their derived types (`export type X = typeof X.Type`),
  constants and errors. No exported functions
  (`architecture/contracts-contain-no-behavior`), no `Layer`, no `Promise`,
  no `node:` or `bun` import.
- `<thing>.entity.functions.ts`: pure functions and Effects over those types.
  Same bans except functions.
- Use cases: `<do-thing>.usecase.ts` + `<do-thing>.usecase.functions.ts`
  (`packages/evals/src/usecases/`).
- Example pair: `core/src/domain/bash.entity.ts` (options, results,
  `BashError`) and `bash.entity.functions.ts` (`collectBashResult`).
- Never write an `interface X` beside `const X = Schema.…`: derive the type
  (`effect/no-parallel-interface`). New domain code never goes in a file
  without a role suffix: the architecture rules would not see it.

## 2. Struct or Class

- `Schema.Struct` (or `Schema.TaggedStruct`) for plain data: payloads,
  configs, results, events. Values are plain object literals. Most of the
  repo's data is this.
- `Schema.Class` when the value is a named domain concept built in many
  places with `new` and checked as a whole: `UserMessage`, `ModelSelection`,
  `UtilityCompletion`. Its constructor runs the schema's checks.
- Errors: `class XError extends Schema.TaggedError<XError>()("XError", { reason, message })`.
- No methods on classes: behaviour lives in the functions file.

## 3. Tagged unions, not flags

- A value that is one of several shapes is a `Schema.Union` of
  `Schema.TaggedStruct`s: `BashEvent = Schema.Union([BashChunk, BashExit])`,
  `CompactionAction` in `core/src/memory/memory-log.entity.ts`. Each variant
  carries only its own fields.
- Not a struct with `isX: boolean` and fields that are meaningful only when
  it is true; not optional fields that must appear together.
- A closed set of words is `Schema.Literals([...])` (`BashTermination`).
- Declare a vocabulary once and import it; never copy its words into
  another schema or a TS type. The turn's words (origin, outcome, end
  reason, failure, ending, step status) are in
  `core/src/domain/turn-vocabulary.entity.ts`. A subset is
  `.pick([...])` (`TaskOutcome`), a superset spreads `.literals`
  (`TaskStatus`), and a union's tags come from
  `.pipe(Schema.toTaggedUnion("_tag"))`: `discriminants` in order
  (`TURN_EVENT_NAMES`), `isAnyOf([...])` as a guard.
- Branch over a union with `Match.valueTags` (skill `effect-idioms`), or,
  for one with `toTaggedUnion`, its own `X.match(value, { … })`, every tag
  named (`LogBody.match`: a tag a function ignores gets its case, `() => []`),
  or `X.matchOrElse` where the default is deliberate (`draftOfTurnEvent`).

## 4. Invariants live in the schema

- Put the rule on the field: `Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))`,
  `Schema.Trimmed.check(Schema.isNonEmpty())`, `Schema.isPattern(…)`.
- A rule across fields goes on the struct:
  `.check(Schema.makeFilter((value) => … ? true : "what is wrong"))`, as
  `UserMessage` requires text or an attachment.
- Then decoding is the only validation: functions take the decoded type and
  do not re-check it.

## 5. Branded ids

- An id is a brand at its definition:
  `export const EntryId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("EntryId"))`
  (also `ConversationId` with `Schema.isUUID()`, `ToolCallId`, `ProviderId`).
- A field named `id` or `<x>Id` is a branded schema, never a bare
  `Schema.String`, a `.check(…)` chain or a local const without a brand.
  `effect/branded-id-fields` checks it through `optionalKey`,
  `OptionFromNullOr`, `Array` and the other wrappers, in every package's
  entity files; follow it everywhere.
- Mint a value with `EntryId.make(…)` where it is created; decode it where it
  arrives.
- A brand adds no runtime check. Branding a field that is already stored
  adds none either, so old records still decode (`RunId` is
  `Schema.String.pipe(Schema.brand("RunId"))`); an input keeps its checks
  under the same brand as its stored form (`InboxItemId` is trimmed and
  non-empty, `inbox.queued` stores it unchecked).

## 6. Absence on the wire

JSON has no `undefined`, and stored payloads outlive the code that wrote them.

| Encoding | Type | On the wire | Use for |
|---|---|---|---|
| `Schema.OptionFromNullOr(X)` | `Option<X>` | key always present, `null` when absent | results and events (`BashResult.exitCode`, `TurnEndedData.failure`) |
| `Schema.optionalKey(X)` | key may be missing | key omitted | inputs and options (`BashOptions`), and stored keys written only when given (`TurnStartedData.meta`) |
| `Schema.OptionFromOptionalKey(X)` | `Option<X>` | key omitted | when the type should be `Option` but the key must stay optional |

- Prefer `Schema.optionalKey` to `Schema.optional`, which also admits an
  explicit `undefined` that JSON cannot carry.
- A key added to a stored payload is optional to older records: skill `change-event`.
- Functions return `Option`, never `A | undefined` (`effect/no-nullable-return`).

## 7. Aggregates

An aggregate whose rules span several facts keeps them as one tagged phase,
not as loose `Ref`s and flags whose combinations nobody wrote down.

- Declare the phase in the `.entity.ts`: a `Schema.Union` of
  `Schema.TaggedStruct`s, `.pipe(Schema.toTaggedUnion("_tag"))`. Each
  variant carries only what holds in it (a flag that matters while open is
  a field of `Open`).
- Write each transition as a pure function in the `.entity.functions.ts`:
  the phase in, the next phase out, or a `Result` whose failure is the
  refusal. Test them as a table, phase by phase.
- The adapter applies a transition with `Ref.modify(ref, decide)`, then
  runs what it planned: queue an item, settle the callers, publish an
  event. Never inside the transition: an inline subscriber may call back
  into the phase.
- Never a `SynchronizedRef` that a consumer fiber transitions: a caller
  holding a permit while it waits on that consumer deadlocks it. A
  semaphore may order work (an admission), never guard the phase.
- Plumbing that is no rule (`Deferred`s, queues, waiters) stays in the
  adapter beside the phase.
- Reference: plugin-sessions `src/turn-writer.entity.ts`, its
  `.entity.functions.ts` and their table test.

## Checklist

- [ ] Schemas and types in `.entity.ts`, behaviour in `.entity.functions.ts`
- [ ] Struct for data, Class for a named concept built with `new`; no methods
- [ ] Variants as tagged structs, not boolean flags
- [ ] A vocabulary declared once, imported where it is used
- [ ] Every invariant in the schema; functions trust the decoded type
- [ ] Every id field branded
- [ ] Absence encoded deliberately (`OptionFromNullOr` vs `optionalKey`)
- [ ] An aggregate's state is one tagged phase, moved by pure transitions under `Ref.modify`
- [ ] `bun run typecheck` (the gates) and the tests beside the functions file
