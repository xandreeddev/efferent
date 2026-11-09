---
name: change-event
description: Add or change a TurnEvent, a journal kind or a stored payload in efferent — the union and its name lists, transient vs journaled vs recorded elsewhere, storedPayload, current-format-only stored shapes, RESERVED_KINDS and frameworkDraft, the hand-kept tables of the event reference, journal fixtures and goldens, docs:generate. Read before touching turn-event.entity.ts, session-event.entity.ts or session-event.entity.functions.ts.
---

# Add or change an event

The turn's events are one vocabulary: plugins publish them, hosts subscribe,
and the journal stores most of them for as long as a session lives. Several
lists must agree; the tests and `bun run docs:generate` fail one at a time
when they do not. Work through this list instead.

## 1. Decide what it is

- An application's own event: `defineHostEvent(name, schema)` in the host or
  plugin; no core change. Journaled under `name`, which must not be in
  `RESERVED_KINDS` (`events.reserved`).
- A plugin's own durable record, not on the bus: its own kind constant and
  schema, exported by the plugin (`TASK_STARTED` and `TaskStarted` in
  `plugin-tasks/src/task-records.entity.ts`).
- A framework bus event: a `TurnEvent` member in core. The rest of this skill.

## 2. The bus event (`packages/core/src/turn/turn-event.entity.ts`)

- `Schema.TaggedStruct("<subject>.<what happened>", { … })`, lowercase,
  past tense where it reports a fact: `tool.refused`, `context.built`,
  `decision.recorded`. Fields follow skill `domain-entity` (branded ids,
  `Schema.OptionFromNullOr` for absent values).
- `.annotate({ description })`: who publishes it and when, what each field
  means, and how it is stored ("Journaled as `x`", "Transient", or "Not
  journaled from the bus: …"). At least 40 characters, unique; the event
  reference is generated from it.
- Add it to the `TurnEvent` union and to `TURN_EVENT_NAMES` in the union's order.
- Update the member list in `turn-event.entity.test.ts`.

## 3. Choose how it is stored

| It is | Do |
|---|---|
| Live rendering only | add it to `TransientTurnEvents`; its description says "Transient" |
| Stored from the bus | add the name to `TURN_EVENT_KINDS` (`core/src/session/session-event.entity.ts`); it is stored whole under its name |
| Stored without some keys (they are in memory already) | also add an entry to `storedPayload` (`session-event.entity.functions.ts`) and its stored schema (`<Name>Data` in `session-event.entity.ts`) to `StoredData`, as `tool.completed` does |
| Read back by its fields (by the framework or a host) | add its stored schema to `StoredData` and its decoder to `storedDecoders` and `recordDecoders`: `readStored`, `decodeStored` and `storedRecordOf` then type it, and `journalSchemaOf` returns that same schema |
| Already recorded by memory or the session | add it to `RECORDED_ELSEWHERE` |

- Append new kinds after the existing ones; never remove or reorder a
  reserved kind (`session-event.entity.test.ts` checks earlier releases'
  order). Every bus name is reserved, stored or not.
- The framework's turn writes reserved kinds through `frameworkDraft(kind, data)`;
  the turn writer refuses any other draft under a reserved kind. A plugin
  never needs `frameworkDraft`; a test standing in for the turn may.

## 4. Changing a stored payload

- Target the current stored format only. Breaking schema changes are permitted;
  flag them in the CHANGELOG and reject unsupported stores without modifying
  their bytes. Do not add migrations or compatibility decoding.
- Any change a reader can tell (a key, a type, an optionality, a check)
  bumps `STORED_FORMAT` (`packages/core/src/session/stored-format.entity.ts`)
  by one: `bun run docs:generate` fails on an unbumped change and names the
  shape, then appends the new format's row to `docs/stored-format.json`.
  Name the new format in the CHANGELOG entry. A description alone is not a
  change.
- Every `STORED_FORMAT` bump needs a fresh store, an added optional key
  included: Sessions refuses every session of another format, reads and
  `list` included (`session.version`). The format is checked per session,
  inside Sessions; the backends check only their own layout when they open
  (files `FILES_LAYOUT`, SQLite `SCHEMA_VERSION`, `store.version`). A release
  that bumps the format alone therefore opens old stores and then refuses
  each session in them, and one such session fails its owner's whole `list`.
  Add a CHANGELOG **Breaking** entry and a **Migration** step (a fresh store;
  read old sessions with the release that wrote them); no update path is
  required. State the new format where `scripts/session-store-docs.test.ts`
  requires it.
- Never re-record a released version's fixture. `bun scripts/record-journal-fixture.ts`
  records the current version's at release time (skill `release`) and refuses
  to overwrite it. During development, `--unreleased --force` refreshes only
  `journal-unreleased.json`. A new journal kind must be
  produced by the recorder's scenario, or the next fixture fails "holds every
  journal kind its version reserved".

## 5. The event reference (`scripts/generate-event-reference.ts`)

Payloads, descriptions and reserved kinds come from the code; some facts are
kept by hand and checked against it. Update the ones your change touches:

- `JOURNAL`: writer and sensitivity of every journal kind.
- `RECORDED_AS`: where each `RECORDED_ELSEWHERE` event ends up.
- `ERROR_CODES` / `TASK_CODES`: where a new code comes from and what it
  means. Add the code to `HARNESS_CODES` (core) too: the script fails on a
  code a package raises that the list does not hold (the kits' own
  `conformance.*` aside), and on a listed code without an entry. A code
  is never renamed or removed; one no longer raised keeps its entry.

Then `bun run docs:generate` and keep `docs/event-reference.json`,
`docs/event-reference.md` and the website's `concepts/event-reference.md` in
the diff. The events guide (`docs/events.md`) quotes regions of
`packages/sdk/src/events-guide.test.ts`: change code there, never in the guide.

## 6. Subscribers and goldens

- Subscribers use `onEvent("<name>", …)`, `subscribeAll`, `TurnEventOf<"<name>">`;
  a consumer of a subset dispatches with `Match.valueTags`
  (`plugin-telemetry/src/turn-telemetry.adapter.ts`). `bun run typecheck`
  finds exhaustive matches that miss the new member.
- If the golden agent publishes it, re-record deliberately and read the diff:
  `EFFERENT_UPDATE_GOLDEN=1` (journal) and `EFFERENT_UPDATE_MODEL_GOLDEN=1`
  (event order the host sees) with `bun test packages/sdk/src/agent.golden.test.ts`.

## Checklist

- [ ] Host event, plugin record or framework event: decided
- [ ] Member, description, union, `TURN_EVENT_NAMES`, member-list test
- [ ] Transient / stored / `storedPayload` / `RECORDED_ELSEWHERE` chosen; kinds appended, none removed
- [ ] Current stored schemas are explicit; unsupported stores fail without mutation
- [ ] `STORED_FORMAT` bumped for a stored-shape change, `docs/stored-format.json` regenerated, the format named in the CHANGELOG
- [ ] `JOURNAL`, `RECORDED_AS`, error-code tables updated; docs:generate output in the diff
- [ ] Recorder scenario writes any new journal kind
- [ ] Goldens re-recorded on purpose and reviewed; CHANGELOG entry
- [ ] `env -u HTTP_PROXY -u HTTPS_PROXY bun test packages/core/src/turn packages/core/src/session packages/sdk/src`
