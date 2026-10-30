---
name: domain-entity
description: Model domain data in efferent — entity/functions file pairs, Schema.Struct vs Schema.Class, tagged unions instead of boolean flags, invariants in the schema, branded ids, and how absence is encoded on the wire (OptionFromNullOr vs optionalKey). Read before creating or changing a *.entity.ts or *.entity.functions.ts, a stored payload or a config schema.
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
  `Checkpoint`. Its constructor runs the schema's checks.
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
- Branch over a union with `Match.valueTags` (skill `effect-idioms`).

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
  `OptionFromNullOr`, `Array` and the other wrappers, in core's
  `src/domain` and `src/spec` and in the entity files of the packages
  `BRANDED_IDS_CLEAN` names; follow it everywhere.
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

## Checklist

- [ ] Schemas and types in `.entity.ts`, behaviour in `.entity.functions.ts`
- [ ] Struct for data, Class for a named concept built with `new`; no methods
- [ ] Variants as tagged structs, not boolean flags
- [ ] A vocabulary declared once, imported where it is used
- [ ] Every invariant in the schema; functions trust the decoded type
- [ ] Every id field branded
- [ ] Absence encoded deliberately (`OptionFromNullOr` vs `optionalKey`)
- [ ] `bun run typecheck` (the gates) and the tests beside the functions file
